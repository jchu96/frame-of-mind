import type { JobListPage } from "../../../../src/domain/studio-ports";
import type { AnalysisJob } from "../../../../src/domain/studio-schemas";
import { validateMediaSessionTransition } from "../../../../src/domain/studio-state";
import type { LocalContextFileStagingAdapter } from "../studio-context/local-context-staging.js";
import type {
  LocalMediaStagingAdapter,
} from "../studio-media/local-media-staging.js";
import type {
  LocalStudioJobWorker,
} from "../studio-jobs/local-job-worker.js";
import type {
  LocalSqliteJobRepository,
} from "../studio-jobs/sqlite-job-repository.js";
import type {
  StudioMaintenanceConfiguration,
} from "./config.js";
import {
  executeStudioMaintenancePlan,
  type StudioMaintenanceSummary,
} from "./executor.js";
import {
  planStudioMaintenance,
  type MaintenanceJobSnapshot,
  type StudioMaintenancePlan,
} from "./plan.js";

const JOB_PAGE_SIZE = 100;

export interface StudioMaintenanceDiagnostics {
  plan: StudioMaintenancePlan;
  lastRun?: StudioMaintenanceSummary;
}

export interface StudioMaintenanceController {
  start(): Promise<StudioMaintenanceSummary>;
  run(): Promise<StudioMaintenanceSummary>;
  diagnostics(): Promise<StudioMaintenanceDiagnostics>;
  stop(): Promise<void>;
  readonly lastRun: StudioMaintenanceSummary | undefined;
}

export interface StudioMaintenanceControllerOptions {
  configuration: StudioMaintenanceConfiguration;
  repository: Pick<LocalSqliteJobRepository, "list" | "markStale">;
  media: Pick<
    LocalMediaStagingAdapter,
    | "delete"
    | "deleteEphemeralExecutionLease"
    | "get"
    | "maintenanceInventory"
    | "transition"
  >;
  contextFiles: Pick<
    LocalContextFileStagingAdapter,
    "deleteForMaintenance" | "maintenanceInventory"
  >;
  worker: Pick<LocalStudioJobWorker, "maintenanceHeartbeat">;
  now?: () => Date;
  scheduleInterval?: (
    callback: () => void,
    intervalMs: number,
  ) => unknown;
  cancelInterval?: (handle: unknown) => void;
  log?: (entry: { code: string; id: string }) => void;
}

function releaseProcessOwnership(handle: unknown): void {
  if (
    handle
    && (typeof handle === "object" || typeof handle === "function")
    && "unref" in handle
    && typeof handle.unref === "function"
  ) {
    handle.unref();
  }
}

function jobSnapshot(job: AnalysisJob): MaintenanceJobSnapshot {
  return {
    id: job.id,
    stage: job.stage,
    updatedAt: job.updatedAt,
    mediaSessionId: job.input.mediaSessionId,
    ...("provider" in job.input.context && job.input.context.provider === "file"
      ? { contextFileId: job.input.context.contextFileId }
      : {}),
    ...(job.runId ? { runId: job.runId } : {}),
  };
}

async function allJobs(
  repository: Pick<LocalSqliteJobRepository, "list">,
): Promise<AnalysisJob[]> {
  const jobs: AnalysisJob[] = [];
  let cursor: string | undefined;
  do {
    const page: JobListPage = await repository.list({
      limit: JOB_PAGE_SIZE,
      order: "oldest",
      ...(cursor ? { cursor } : {}),
    });
    jobs.push(...page.jobs);
    cursor = page.nextCursor;
  } while (cursor);
  return jobs;
}

export function createStudioMaintenanceController(
  options: StudioMaintenanceControllerOptions,
): StudioMaintenanceController {
  const now = options.now ?? (() => new Date());
  const scheduleInterval = options.scheduleInterval
    ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const cancelInterval = options.cancelInterval
    ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const log = options.log ?? ((entry) => {
    console.info("Local Studio maintenance action.", entry);
  });
  let stopped = false;
  let started = false;
  let timer: unknown;
  let active: Promise<StudioMaintenanceSummary> | undefined;
  let lastRun: StudioMaintenanceSummary | undefined;

  const collectPlan = async (): Promise<StudioMaintenancePlan> => {
    const generatedAt = now().toISOString();
    const [jobs, media, contextFiles] = await Promise.all([
      allJobs(options.repository),
      options.media.maintenanceInventory(),
      options.contextFiles.maintenanceInventory(),
    ]);
    const heartbeat = options.worker.maintenanceHeartbeat;
    return planStudioMaintenance({
      now: generatedAt,
      staleJobHorizonMs: options.configuration.staleJobHorizonMs,
      orphanGraceMs: options.configuration.orphanGraceMs,
      jobs: jobs.map(jobSnapshot),
      media,
      contextFiles,
      heartbeats: heartbeat ? [heartbeat] : [],
    });
  };

  const execute = async (): Promise<StudioMaintenanceSummary> => {
    const plan = await collectPlan();
    const summary = await executeStudioMaintenancePlan(plan, {
      deleteMedia: async (id) => {
        let session = await options.media.get(id);
        if (!session || session.status === "deleted") return false;
        if (
          session.retention.mode === "retained"
          && ["sealed", "retained", "in_use"].includes(session.status)
          && Date.parse(session.retention.expiresAt) > now().getTime()
        ) {
          return false;
        }
        if (session.status === "in_use") {
          if (session.retention.mode === "ephemeral") {
            if (!session.sha256) return false;
            await options.media.deleteEphemeralExecutionLease(
              id,
              session.sha256,
            );
            return true;
          }
          session = await options.media.transition(
            validateMediaSessionTransition({
              id,
              expected: "in_use",
              next: "retained",
            }),
          );
        }
        await options.media.delete(session.id);
        return true;
      },
      deleteContextFile: (id) => options.contextFiles.deleteForMaintenance(id),
      markJobStale: (id, expectedStage, expectedUpdatedAt, occurredAt) =>
        options.repository.markStale({
          jobId: id,
          expectedStage,
          expectedUpdatedAt,
          occurredAt,
        }),
      log,
    }, { now: () => now().toISOString() });
    lastRun = summary;
    return summary;
  };

  const run = (): Promise<StudioMaintenanceSummary> => {
    if (active) return active;
    const current = execute().finally(() => {
      if (active === current) active = undefined;
    });
    active = current;
    return current;
  };

  return {
    get lastRun() {
      return lastRun;
    },
    async start() {
      if (started || stopped) {
        throw new Error("Studio maintenance controller already started or stopped.");
      }
      started = true;
      const summary = await run();
      if (options.configuration.scheduled) {
        timer = scheduleInterval(() => {
          void run().catch(() => {
            log({ code: "maintenance_run_failed", id: "maintenance_system" });
          });
        }, options.configuration.intervalMs);
        releaseProcessOwnership(timer);
      }
      return summary;
    },
    run,
    async diagnostics() {
      return {
        plan: await collectPlan(),
        ...(lastRun ? { lastRun } : {}),
      };
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        cancelInterval(timer);
        timer = undefined;
      }
      await active;
    },
  };
}
