import type {
  AnalysisJobExecutor,
  JobRepository,
  ProgressReporter,
} from "../../../../src/domain/studio-ports";
import {
  AnalysisExecutionIndeterminateError,
} from "../../../../src/domain/studio-ports";
import {
  analysisJobExecutionResultSchema,
  type AnalysisJob,
  type AnalysisJobEvent,
} from "../../../../src/domain/studio-schemas";
import {
  ANALYSIS_JOB_STAGES,
  isAnalysisJobTerminal,
} from "../../../../src/domain/studio-state";
import type {
  AnalysisJobStage,
} from "../../../../src/domain/studio-types";

const ACTIVE_STAGES = ANALYSIS_JOB_STAGES.filter(
  (stage) => stage !== "queued" && !isAnalysisJobTerminal(stage),
);
const PAGE_SIZE = 100;

export interface StudioJobReconciliationReport {
  interruptedJobIds: string[];
}

export interface LocalStudioJobWorkerOptions {
  now?: () => string;
  onWorkerError?: (error: StudioJobWorkerError) => Promise<void> | void;
}

export class StudioJobWorkerError extends Error {
  constructor(
    readonly code: string,
    readonly jobId?: string,
  ) {
    super(jobId
      ? `Local Studio job worker failed for ${jobId}.`
      : "Local Studio job worker failed.");
    this.name = "StudioJobWorkerError";
  }
}

/**
 * A process-local, single-concurrency durable queue runner.
 *
 * The repository owns job truth. This worker owns only the active
 * AbortController and wake-up loop, so a browser refresh cannot cancel work.
 * The production application must construct one singleton worker per local
 * SQLite database.
 */
export class LocalStudioJobWorker {
  private readonly now: () => string;
  private readonly onWorkerError: NonNullable<
    LocalStudioJobWorkerOptions["onWorkerError"]
  >;
  private started = false;
  private stopping = false;
  private wakeRequested = false;
  private startupPromise:
    | Promise<StudioJobReconciliationReport>
    | undefined;
  private drainPromise: Promise<void> | undefined;
  private active:
    | { jobId: string; controller: AbortController }
    | undefined;

  constructor(
    private readonly repository: JobRepository,
    private readonly executor: AnalysisJobExecutor,
    options: LocalStudioJobWorkerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onWorkerError = options.onWorkerError ?? (() => undefined);
  }

  get activeJobId(): string | undefined {
    return this.active?.jobId;
  }

  async start(): Promise<StudioJobReconciliationReport> {
    if (this.started || this.startupPromise) {
      throw new StudioJobWorkerError("worker_already_started");
    }
    if (this.stopping) {
      throw new StudioJobWorkerError("worker_stopped");
    }
    const startup = this.startInternal();
    this.startupPromise = startup;
    try {
      return await startup;
    } finally {
      this.startupPromise = undefined;
    }
  }

  /**
   * Announces that durable queue state may have changed. Repeated calls
   * coalesce and never create a second drain loop.
   */
  notify(): void {
    if (!this.started || this.stopping) return;
    this.wakeRequested = true;
    if (!this.drainPromise) this.launchDrain();
  }

  /**
   * Signals only after JobRepository.requestCancellation has durably committed.
   */
  notifyCancellationPersisted(jobId: string): void {
    if (this.active?.jobId === jobId) this.active.controller.abort();
    this.notify();
  }

  async whenIdle(): Promise<void> {
    while (this.drainPromise) {
      await this.drainPromise;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.started && !this.startupPromise) return;
    if (this.stopping) {
      await this.startupPromise?.catch(() => undefined);
      await this.whenIdle();
      return;
    }
    this.stopping = true;
    this.active?.controller.abort();
    await this.startupPromise?.catch(() => undefined);
    await this.whenIdle();
  }

  private async startInternal(): Promise<StudioJobReconciliationReport> {
    const report = await this.reconcileInterruptedJobs();
    if (this.stopping) return report;
    this.started = true;
    this.notify();
    return report;
  }

  private launchDrain(): void {
    const drain = this.drain();
    this.drainPromise = drain.finally(() => {
      this.drainPromise = undefined;
      if (this.wakeRequested && !this.stopping) this.launchDrain();
    });
  }

  private async drain(): Promise<void> {
    this.wakeRequested = false;
    while (!this.stopping) {
      let job: AnalysisJob | undefined;
      try {
        job = (await this.repository.list({
          limit: 1,
          order: "oldest",
          stages: ["queued"],
        })).jobs[0];
      } catch {
        await this.reportWorkerError(
          new StudioJobWorkerError("queue_read_failed"),
        );
        return;
      }
      if (!job) return;
      if (this.stopping) return;
      if (job.cancellationRequestedAt) {
        try {
          await this.finishUnsuccessful(job.id, "canceled");
        } catch {
          await this.reportWorkerError(
            new StudioJobWorkerError("job_persistence_failed", job.id),
          );
          return;
        }
        continue;
      }
      try {
        await this.executeOne(job);
      } catch {
        await this.reportWorkerError(
          new StudioJobWorkerError("job_persistence_failed", job.id),
        );
        return;
      }
    }
  }

  private async executeOne(queuedJob: AnalysisJob): Promise<void> {
    const controller = new AbortController();
    this.active = { jobId: queuedJob.id, controller };
    try {
      const claimed = await this.repository.transition({
        jobId: queuedJob.id,
        expectedStage: "queued",
        nextStage: "fetching_context",
        occurredAt: this.timestampAtOrAfter(queuedJob.updatedAt),
        message: "Claimed by the local single-concurrency executor.",
      });
      if (claimed.cancellationRequestedAt) controller.abort();
      if (this.stopping) controller.abort();
      if (controller.signal.aborted) {
        await this.finishUnsuccessful(
          claimed.id,
          claimed.cancellationRequestedAt ? "canceled" : "interrupted",
        );
        return;
      }

      let rawResult: unknown;
      try {
        rawResult = await this.executor.execute(claimed, {
          signal: controller.signal,
          progress: this.progressReporter(claimed),
        });
      } catch (error) {
        const indeterminate =
          error instanceof AnalysisExecutionIndeterminateError;
        const latest = await this.requireJob(claimed.id);
        const canceled = latest.cancellationRequestedAt !== undefined;
        await this.finishUnsuccessful(
          claimed.id,
          indeterminate
            ? "interrupted"
            : canceled
              ? "canceled"
              : controller.signal.aborted
                ? "interrupted"
                : "failed",
          indeterminate
            ? {
                code: "executor_result_invalid",
                message:
                  "Execution completed with an invalid publication receipt; explicit retry is required.",
              }
            : undefined,
        );
        return;
      }

      const result = analysisJobExecutionResultSchema.safeParse(rawResult);
      if (!result.success) {
        await this.finishUnsuccessful(claimed.id, "interrupted", {
          code: "executor_result_invalid",
          message:
            "Execution completed with an invalid publication receipt; explicit retry is required.",
        });
        return;
      }
      await this.finishSucceeded(claimed.id, result.data);
    } finally {
      if (this.active?.jobId === queuedJob.id) this.active = undefined;
    }
  }

  private progressReporter(job: AnalysisJob): ProgressReporter {
    return {
      report: async (event) => {
        this.assertBoundProgressEvent(job, event);
        if (event.kind === "transition") {
          await this.repository.transition({
            jobId: job.id,
            expectedStage: event.previousStage,
            nextStage: event.stage,
            occurredAt: event.occurredAt,
            message: event.message,
          });
          return;
        }
        await this.repository.appendEvent(event);
      },
    };
  }

  private assertBoundProgressEvent(
    job: AnalysisJob,
    event: Omit<AnalysisJobEvent, "sequence">,
  ): void {
    if (event.jobId !== job.id || event.attempt !== job.attempt) {
      throw new StudioJobWorkerError("progress_job_mismatch", job.id);
    }
    if (isAnalysisJobTerminal(event.stage)) {
      throw new StudioJobWorkerError("terminal_progress_forbidden", job.id);
    }
    if (
      event.kind === "transition"
      && (
        event.previousStage === "queued"
        || event.stage === "fetching_context"
      )
    ) {
      throw new StudioJobWorkerError("claim_transition_repeated", job.id);
    }
  }

  private async finishSucceeded(
    jobId: string,
    result: {
      runId: string;
      projectionWarning?: string;
    },
  ): Promise<void> {
    let job = await this.requireJob(jobId);
    if (isAnalysisJobTerminal(job.stage)) return;
    if (job.stage !== "cleaning_up") {
      job = await this.repository.transition({
        jobId,
        expectedStage: job.stage,
        nextStage: "cleaning_up",
        occurredAt: this.timestampAtOrAfter(job.updatedAt),
        message: "Finalizing the published analysis run.",
      });
    }
    await this.repository.transition({
      jobId,
      expectedStage: "cleaning_up",
      nextStage: "succeeded",
      occurredAt: this.timestampAtOrAfter(job.updatedAt),
      message: "Analysis run published successfully.",
      runId: result.runId,
      projectionWarning: result.projectionWarning,
    });
  }

  private async finishUnsuccessful(
    jobId: string,
    outcome: "failed" | "canceled" | "interrupted",
    override?: { code: string; message: string },
  ): Promise<void> {
    let job = await this.requireJob(jobId);
    if (isAnalysisJobTerminal(job.stage)) return;
    if (job.runId) {
      throw new StudioJobWorkerError(
        "published_job_requires_reconciliation",
        jobId,
      );
    }
    const defaults = outcome === "interrupted"
      ? {
          code: "executor_interrupted",
          message:
            "Local execution stopped before publication; explicit retry is required.",
        }
      : outcome === "canceled"
        ? {
            code: "operator_canceled",
            message: "Analysis was canceled by the local operator.",
          }
      : {
          code: "analysis_failed",
          message: "Analysis execution failed.",
        };
    if (job.stage !== "cleaning_up") {
      job = await this.repository.transition({
        jobId,
        expectedStage: job.stage,
        nextStage: "cleaning_up",
        occurredAt: this.timestampAtOrAfter(job.updatedAt),
        message: "Finalizing the unsuccessful analysis attempt.",
      });
    }
    await this.repository.transition({
      jobId,
      expectedStage: "cleaning_up",
      nextStage: outcome,
      occurredAt: this.timestampAtOrAfter(job.updatedAt),
      code: override?.code ?? defaults.code,
      message: override?.message ?? defaults.message,
    });
  }

  private async reconcileInterruptedJobs():
    Promise<StudioJobReconciliationReport> {
    const interruptedJobIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.list({
        limit: PAGE_SIZE,
        order: "oldest",
        stages: ACTIVE_STAGES,
        ...(cursor ? { cursor } : {}),
      });
      for (const job of page.jobs) {
        await this.repository.transition({
          jobId: job.id,
          expectedStage: job.stage,
          nextStage: "interrupted",
          occurredAt: this.timestampAtOrAfter(job.updatedAt),
          code: "executor_restart",
          message:
            "Local process restarted during execution; explicit retry is required.",
        });
        interruptedJobIds.push(job.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { interruptedJobIds };
  }

  private async requireJob(jobId: string): Promise<AnalysisJob> {
    const job = await this.repository.get(jobId);
    if (!job) throw new StudioJobWorkerError("job_not_found", jobId);
    return job;
  }

  private timestampAtOrAfter(previous: string): string {
    const candidate = this.now();
    return Date.parse(candidate) < Date.parse(previous) ? previous : candidate;
  }

  private async reportWorkerError(error: StudioJobWorkerError): Promise<void> {
    try {
      await this.onWorkerError(error);
    } catch {
      // A diagnostics sink must not create another worker failure.
    }
  }
}
