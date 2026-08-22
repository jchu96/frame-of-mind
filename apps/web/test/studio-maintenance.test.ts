import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyImmutableJobInput } from "../../../src/domain/studio-schemas";
import {
  maintenanceConfiguration,
} from "../server-local/studio-maintenance/config";
import {
  executeStudioMaintenancePlan,
} from "../server-local/studio-maintenance/executor";
import {
  planStudioMaintenance,
  type StudioMaintenanceInput,
} from "../server-local/studio-maintenance/plan";
import {
  createStudioMaintenanceController,
} from "../server-local/studio-maintenance/controller";
import {
  LocalContextFileStagingAdapter,
} from "../server-local/studio-context/local-context-staging";
import {
  LocalSqliteJobRepository,
} from "../server-local/studio-jobs/sqlite-job-repository";
import {
  LocalMediaStagingAdapter,
} from "../server-local/studio-media/local-media-staging";

const now = "2026-08-22T12:00:00.000Z";
const old = "2026-08-20T12:00:00.000Z";
const recent = "2026-08-22T11:59:30.000Z";
const future = "2026-08-23T12:00:00.000Z";
const digest = "a".repeat(64);

function maintenanceInput(): StudioMaintenanceInput {
  return {
    now,
    staleJobHorizonMs: 60 * 60 * 1_000,
    orphanGraceMs: 60 * 60 * 1_000,
    heartbeats: [
      { jobId: "job_live", observedAt: recent },
    ],
    jobs: [
      {
        id: "job_stale",
        stage: "indexing",
        updatedAt: old,
        mediaSessionId: "media_for_stale_job",
      },
      {
        id: "job_live",
        stage: "interrogating",
        updatedAt: old,
        mediaSessionId: "media_live_lease",
        contextFileId: "context_live_lease",
      },
      {
        id: "job_finished",
        stage: "succeeded",
        updatedAt: old,
        mediaSessionId: "media_finished_job",
      },
    ],
    media: [
      {
        id: "media_expired",
        ownership: "studio_staged_copy",
        status: "sealed",
        retention: { mode: "ephemeral", expiresAt: old },
        updatedAt: old,
        sha256: digest,
      },
      {
        id: "media_orphan",
        ownership: "studio_staged_copy",
        status: "sealed",
        retention: { mode: "ephemeral", expiresAt: future },
        updatedAt: old,
        sha256: digest,
      },
      {
        id: "media_retained_live",
        ownership: "studio_staged_copy",
        status: "retained",
        retention: { mode: "retained", expiresAt: future },
        updatedAt: old,
        sha256: digest,
      },
      {
        id: "media_retained_upload_expired",
        ownership: "studio_staged_copy",
        status: "uploading",
        retention: { mode: "retained", expiresAt: future },
        uploadExpiresAt: old,
        updatedAt: old,
      },
      {
        id: "media_live_lease",
        ownership: "studio_staged_copy",
        status: "in_use",
        retention: { mode: "retained", expiresAt: future },
        updatedAt: old,
        sha256: digest,
      },
      {
        id: "local_explicit_recording",
        ownership: "explicit_local_recording",
        status: "sealed",
        retention: { mode: "ephemeral", expiresAt: old },
        updatedAt: old,
        sha256: digest,
      },
    ],
    contextFiles: [
      {
        id: "context_expired",
        ownership: "studio_staged_copy",
        expiresAt: old,
        updatedAt: old,
      },
      {
        id: "context_live_lease",
        ownership: "studio_staged_copy",
        expiresAt: future,
        updatedAt: old,
      },
    ],
  };
}

describe("Local Studio maintenance planner", () => {
  test("plans expired, orphaned, and stale work without crossing preservation gates", () => {
    const plan = planStudioMaintenance(maintenanceInput());

    expect(plan).toEqual({
      generatedAt: now,
      actions: [
        {
          action: "delete_context",
          id: "context_expired",
          reason: "context_expired",
        },
        {
          action: "delete_media",
          id: "media_expired",
          reason: "media_expired",
        },
        {
          action: "delete_media",
          id: "media_orphan",
          reason: "media_orphaned",
        },
        {
          action: "delete_media",
          id: "media_retained_upload_expired",
          reason: "media_expired",
        },
        {
          action: "mark_job_stale",
          expectedStage: "indexing",
          expectedUpdatedAt: old,
          id: "job_stale",
          reason: "stale_without_heartbeat",
        },
      ],
    });
    expect(JSON.stringify(plan)).not.toContain("explicit_local_recording");
    expect(JSON.stringify(plan)).not.toContain("media_retained_live");
    expect(JSON.stringify(plan)).not.toContain("job_live");
    expect(JSON.stringify(plan)).not.toContain("context_live_lease");
  });

  test("uses strict cutoffs and rejects unsafe or invalid planner input", () => {
    const input = maintenanceInput();
    input.jobs[0]!.updatedAt = "2026-08-22T11:00:00.000Z";
    expect(planStudioMaintenance(input).actions.some(
      (action) => action.id === "job_stale",
    )).toBe(true);

    expect(() => planStudioMaintenance({
      ...maintenanceInput(),
      jobs: [{
        id: "/private/recording.mov",
        stage: "queued",
        updatedAt: old,
        mediaSessionId: "media_safe",
      }],
    })).toThrow("sanitized");
  });
});

describe("Local Studio maintenance executor", () => {
  test("applies a plan idempotently and logs codes plus sanitized ids only", async () => {
    const plan = planStudioMaintenance(maintenanceInput());
    const deletedMedia = new Set<string>();
    const deletedContext = new Set<string>();
    const staleJobs = new Set<string>();
    const logs: unknown[] = [];
    const ports = {
      deleteMedia: async (id: string) => {
        if (deletedMedia.has(id)) return false;
        deletedMedia.add(id);
        return true;
      },
      deleteContextFile: async (id: string) => {
        if (deletedContext.has(id)) return false;
        deletedContext.add(id);
        return true;
      },
      markJobStale: async (id: string) => {
        if (staleJobs.has(id)) return false;
        staleJobs.add(id);
        return true;
      },
      log: (entry: unknown) => logs.push(entry),
    };

    const first = await executeStudioMaintenancePlan(plan, ports);
    const second = await executeStudioMaintenancePlan(plan, ports);

    expect(first).toMatchObject({
      planned: 5,
      applied: 5,
      removed: 4,
      staleJobs: 1,
      failures: [],
    });
    expect(second).toMatchObject({
      planned: 5,
      applied: 0,
      removed: 0,
      staleJobs: 0,
      failures: [],
    });
    expect(JSON.stringify(logs)).not.toContain("recording.mov");
    expect(logs.every((entry) => {
      const keys = Object.keys(entry as Record<string, unknown>);
      return keys.every((key) => ["code", "id"].includes(key));
    })).toBe(true);
  });
});

describe("Local Studio maintenance configuration", () => {
  test("uses safe defaults and allows only the scheduled interval to be disabled", () => {
    expect(maintenanceConfiguration({})).toEqual({
      intervalMs: 15 * 60 * 1_000,
      orphanGraceMs: 24 * 60 * 60 * 1_000,
      scheduled: true,
      staleJobHorizonMs: 24 * 60 * 60 * 1_000,
    });
    expect(maintenanceConfiguration({
      FRAME_OF_MIND_MAINTENANCE_INTERVAL_MS: "0",
    }).scheduled).toBe(false);
    expect(() => maintenanceConfiguration({
      FRAME_OF_MIND_MAINTENANCE_STALE_JOB_MS: "nope",
    })).toThrow("positive integer");
  });
});

describe("Local Studio stale-job repository action", () => {
  test("atomically emits a warning and terminalizes once", async () => {
    const database = new Database(":memory:");
    const repository = new LocalSqliteJobRepository(database, {
      createId: () => "job_stale_repository",
    });
    const input = await verifyImmutableJobInput({
      mediaSessionId: "media_stale_repository",
      mediaSha256: digest,
      context: { mode: "none" },
      recipe: {
        id: "issue-review",
        custom: false,
        revision: "builtin-v1",
        sha256: digest,
      },
      model: "gemini-3.7-flash",
      retention: { mode: "ephemeral", expiresAt: future },
    });
    const created = await repository.createOrReplay({
      idempotencyKey: "maintenance-stale-job",
      verifiedInput: input,
      createdAt: old,
    });

    const first = await repository.markStale({
      jobId: created.job.id,
      expectedStage: "queued",
      expectedUpdatedAt: old,
      occurredAt: now,
    });
    const second = await repository.markStale({
      jobId: created.job.id,
      expectedStage: "queued",
      expectedUpdatedAt: old,
      occurredAt: now,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await repository.get(created.job.id)).toMatchObject({
      stage: "interrupted",
      terminal: {
        code: "maintenance_stale_job",
        outcome: "interrupted",
      },
    });
    expect((await repository.events(created.job.id)).map((event) => ({
      kind: event.kind,
      code: "code" in event ? event.code : undefined,
    }))).toEqual([
      { kind: "warning", code: "maintenance_stale_job" },
      { kind: "transition", code: undefined },
    ]);
    database.close();
  });
});

describe("Local Studio maintenance controller", () => {
  test("runs at startup and deletes only owned expired or old orphan staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "frame-of-mind-maintenance-"));
    const checkout = join(root, "checkout");
    const mediaRoot = join(root, "private-media");
    const contextRoot = join(root, "private-context");
    const sourceRecording = join(root, "operator-source.mov");
    await mkdir(checkout);
    await writeFile(sourceRecording, "operator-owned");
    let clock = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    const mediaIds = [
      "media_expired_controller",
      "media_orphan_controller",
      "media_retained_controller",
    ];
    const media = new LocalMediaStagingAdapter({
      rootDirectory: mediaRoot,
      checkoutRoot: checkout,
      now: () => clock,
      createId: () => mediaIds.shift()!,
      minimumFreeBytes: 0,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });
    await media.create({
      idempotencyKey: "maintenance-expired-controller",
      expectedBytes: 16,
      mimeType: "video/mp4",
      retention: { mode: "ephemeral" },
    });
    clock = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await media.create({
      idempotencyKey: "maintenance-orphan-controller",
      expectedBytes: 16,
      mimeType: "video/mp4",
      retention: { mode: "ephemeral" },
    });
    clock = new Date();
    await media.create({
      idempotencyKey: "maintenance-retained-controller",
      expectedBytes: 16,
      mimeType: "video/mp4",
      retention: { mode: "retained", ttlSeconds: 7 * 24 * 60 * 60 },
    });

    clock = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const context = new LocalContextFileStagingAdapter({
      rootDirectory: contextRoot,
      checkoutRoot: checkout,
      now: () => clock,
      createId: () => "context_expired_controller",
    });
    const contextBytes = new TextEncoder().encode("Synthetic context");
    await context.stage({
      format: "text",
      expectedBytes: contextBytes.byteLength,
      bytes: (async function* () { yield contextBytes; })(),
    });
    const database = new Database(":memory:");
    const repository = new LocalSqliteJobRepository(database);
    const controller = createStudioMaintenanceController({
      configuration: {
        intervalMs: 0,
        orphanGraceMs: 60 * 60 * 1_000,
        scheduled: false,
        staleJobHorizonMs: 60 * 60 * 1_000,
      },
      repository,
      media,
      contextFiles: context,
      worker: { maintenanceHeartbeat: undefined },
      now: () => new Date(),
      log: () => undefined,
    });

    const summary = await controller.start();
    const diagnostics = await controller.diagnostics();

    expect(summary).toMatchObject({ applied: 3, removed: 3, staleJobs: 0 });
    expect((await media.get("media_expired_controller"))?.status).toBe("deleted");
    expect((await media.get("media_orphan_controller"))?.status).toBe("deleted");
    expect((await media.get("media_retained_controller"))?.status).not.toBe("deleted");
    expect(await readFile(sourceRecording, "utf8")).toBe("operator-owned");
    expect(await context.maintenanceInventory()).toEqual([]);
    expect(diagnostics.plan.actions).toEqual([]);

    await controller.stop();
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("binds the changed-run summary on Home without adding another authority", async () => {
    const source = await readFile(
      new URL("../server-local/studio-ui/home.vue", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'useFetch<StudioMaintenanceDiagnostics>("/api/studio/maintenance"',
    );
    expect(source).toContain("summary.applied === 0");
    expect(source).toContain(
      "Maintenance ran ${ago}, removed ${staged}${stale}.",
    );
    expect(source).toContain("data-studio-maintenance-summary");
  });

  test("runs once before scheduling and coalesces an interval callback", async () => {
    let inventoryReads = 0;
    let scheduled: (() => void) | undefined;
    let scheduledDelay = 0;
    let canceled = false;
    const controller = createStudioMaintenanceController({
      configuration: {
        intervalMs: 123_000,
        orphanGraceMs: 60_000,
        scheduled: true,
        staleJobHorizonMs: 60_000,
      },
      repository: {
        list: async () => ({ jobs: [] }),
        markStale: async () => false,
      },
      media: {
        maintenanceInventory: async () => {
          inventoryReads += 1;
          return [];
        },
        get: async () => undefined,
        delete: async () => {
          throw new Error("unexpected delete");
        },
        deleteEphemeralExecutionLease: async () => {
          throw new Error("unexpected delete");
        },
        transition: async () => {
          throw new Error("unexpected transition");
        },
      },
      contextFiles: {
        maintenanceInventory: async () => [],
        deleteForMaintenance: async () => false,
      },
      worker: { maintenanceHeartbeat: undefined },
      scheduleInterval: (callback, delay) => {
        scheduled = callback;
        scheduledDelay = delay;
        return { unref() {} };
      },
      cancelInterval: () => {
        canceled = true;
      },
      log: () => undefined,
    });

    await controller.start();
    expect(inventoryReads).toBe(1);
    expect(scheduledDelay).toBe(123_000);
    scheduled!();
    scheduled!();
    await controller.run();
    expect(inventoryReads).toBe(2);
    await controller.stop();
    expect(canceled).toBe(true);
  });
});
