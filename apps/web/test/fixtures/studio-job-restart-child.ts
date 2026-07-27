import { Database } from "bun:sqlite";
import type {
  AnalysisJobExecutor,
  MediaStagingAdapter,
} from "../../../../src/domain/studio-ports";
import {
  mediaSessionSchema,
  verifyImmutableJobInput,
  type AnalysisJob,
} from "../../../../src/domain/studio-schemas";
import {
  LocalStudioJobControl,
} from "../../server-local/studio-jobs/job-control";
import {
  LocalStudioJobWorker,
} from "../../server-local/studio-jobs/local-job-worker";
import {
  LocalMediaReuseGuard,
} from "../../server-local/studio-jobs/media-reuse-guard";
import {
  LocalSqliteJobRepository,
} from "../../server-local/studio-jobs/sqlite-job-repository";

export const RESTART_FIXTURE_IDS = {
  running: "job_restart_running_01",
  canceling: "job_restart_canceling_01",
  queued: "job_restart_queued_01",
  succeeded: "job_restart_succeeded_01",
  failed: "job_restart_failed_01",
  retry: "job_restart_retry_02",
} as const;

const baseTime = Date.parse("2026-07-27T12:00:00.000Z");
const mediaSha256 = "a".repeat(64);
const immutableInput = {
  mediaSessionId: "media_restart_fixture_01",
  mediaSha256,
  context: {
    provider: "bluedot" as const,
    transport: "mcp" as const,
    meetingId: "synthetic-restart-meeting",
  },
  recipe: {
    id: "issue-review",
    custom: false,
    revision: "builtin-v1",
    sha256: "b".repeat(64),
  },
  model: "gemini-3.6-flash",
  retention: {
    mode: "retained" as const,
    expiresAt: "2026-07-29T12:00:00.000Z",
  },
};

async function main(): Promise<void> {
  const [mode, databasePath] = process.argv.slice(2);
  if (!databasePath || (mode !== "seed" && mode !== "recover")) {
    throw new Error("Expected seed|recover and a SQLite path.");
  }
  if (mode === "seed") {
    await seedThenCrash(databasePath);
    return;
  }
  await recoverAndRetry(databasePath);
}

async function seedThenCrash(databasePath: string): Promise<never> {
  const database = new Database(databasePath, { create: true });
  const ids = [
    RESTART_FIXTURE_IDS.running,
    RESTART_FIXTURE_IDS.canceling,
    RESTART_FIXTURE_IDS.queued,
    RESTART_FIXTURE_IDS.succeeded,
    RESTART_FIXTURE_IDS.failed,
  ];
  let idIndex = 0;
  const repository = new LocalSqliteJobRepository(database, {
    createId: () => {
      const id = ids[idIndex];
      idIndex += 1;
      if (!id) throw new Error("Restart fixture exhausted deterministic IDs.");
      return id;
    },
  });
  const jobs: AnalysisJob[] = [];
  for (const [index] of ids.entries()) {
    jobs.push(
      await createJob(
        repository,
        `restart-fixture-${index + 1}`,
        index * 60_000,
      ),
    );
  }
  let occurredAt = baseTime + 60 * 60_000;
  const nextTime = () => {
    occurredAt += 1_000;
    return new Date(occurredAt).toISOString();
  };

  await advance(
    repository,
    jobs[0]!,
    ["fetching_context", "uploading_to_gemini"],
    nextTime,
  );
  const canceling = await advance(
    repository,
    jobs[1]!,
    ["fetching_context", "uploading_to_gemini", "indexing"],
    nextTime,
  );
  await repository.requestCancellation(canceling.id, nextTime());

  const succeeded = await advance(
    repository,
    jobs[3]!,
    ["fetching_context", "cleaning_up"],
    nextTime,
  );
  await repository.transition({
    jobId: succeeded.id,
    expectedStage: "cleaning_up",
    nextStage: "succeeded",
    occurredAt: nextTime(),
    runId: "run_restart_fixture_existing",
    message: "Synthetic terminal success before process loss.",
  });

  const failed = await advance(
    repository,
    jobs[4]!,
    ["fetching_context", "cleaning_up"],
    nextTime,
  );
  await repository.transition({
    jobId: failed.id,
    expectedStage: "cleaning_up",
    nextStage: "failed",
    occurredAt: nextTime(),
    code: "synthetic_failure",
    message: "Synthetic terminal failure before process loss.",
  });

  // Deliberately skip repository/database shutdown. This represents a process
  // disappearing after committed SQLite writes, not cooperative worker stop.
  process.exit(73);
}

async function recoverAndRetry(databasePath: string): Promise<void> {
  const database = new Database(databasePath);
  const repository = new LocalSqliteJobRepository(database, {
    createId: () => RESTART_FIXTURE_IDS.retry,
  });
  const now = monotonicClock(Date.parse("2026-07-27T15:00:00.000Z"));
  const executor: AnalysisJobExecutor = {
    async execute(job, { progress }) {
      await progress.report({
        jobId: job.id,
        attempt: job.attempt,
        kind: "transition",
        previousStage: "fetching_context",
        stage: "cleaning_up",
        occurredAt: now(),
        message: "Synthetic recovery execution completed.",
      });
      return { runId: `run_${job.id}` };
    },
  };
  const worker = new LocalStudioJobWorker(repository, executor, { now });
  try {
    const report = await worker.start();
    await worker.whenIdle();

    const control = new LocalStudioJobControl(
      repository,
      worker,
      new LocalMediaReuseGuard(retainedMediaAdapter()),
    );
    const retry = await control.createLinkedRetry({
      parentJobId: RESTART_FIXTURE_IDS.running,
      idempotencyKey: "restart-fixture-explicit-retry",
      createdAt: now(),
    });
    await worker.whenIdle();

    console.log(JSON.stringify({
      interruptedJobIds: report.interruptedJobIds,
      retryKind: retry.kind,
      retryJobId: retry.job.id,
    }));
  } finally {
    await worker.shutdown();
    database.close();
  }
}

async function createJob(
  repository: LocalSqliteJobRepository,
  idempotencyKey: string,
  offsetMilliseconds: number,
): Promise<AnalysisJob> {
  const result = await repository.createOrReplay({
    idempotencyKey,
    verifiedInput: await verifyImmutableJobInput(immutableInput),
    createdAt: new Date(baseTime + offsetMilliseconds).toISOString(),
  });
  return result.job;
}

async function advance(
  repository: LocalSqliteJobRepository,
  initial: AnalysisJob,
  stages: AnalysisJob["stage"][],
  now: () => string,
): Promise<AnalysisJob> {
  let job = initial;
  for (const nextStage of stages) {
    job = await repository.transition({
      jobId: job.id,
      expectedStage: job.stage,
      nextStage,
      occurredAt: now(),
    });
  }
  return job;
}

function monotonicClock(start: number): () => string {
  let milliseconds = start;
  return () => {
    milliseconds += 1_000;
    return new Date(milliseconds).toISOString();
  };
}

function retainedMediaAdapter(): MediaStagingAdapter {
  const session = mediaSessionSchema.parse({
    id: immutableInput.mediaSessionId,
    status: "retained",
    expectedBytes: 1,
    receivedBytes: 1,
    partSizeBytes: 1,
    parts: [{
      part: 0,
      offset: 0,
      bytes: 1,
      sha256: "c".repeat(64),
      receivedAt: "2026-07-27T11:59:00.000Z",
    }],
    mimeType: "video/mp4",
    sha256: mediaSha256,
    retention: immutableInput.retention,
    createdAt: "2026-07-27T11:58:00.000Z",
    updatedAt: "2026-07-27T14:00:00.000Z",
  });
  const unsupported = async (): Promise<never> => {
    throw new Error("Restart fixture only supports retained-media lookup.");
  };
  return {
    create: unsupported,
    async get(id) {
      return id === session.id ? session : undefined;
    },
    writePart: unsupported,
    seal: unsupported,
    transition: unsupported,
    abort: unsupported,
    delete: unsupported,
    expire: unsupported,
    reconcile: unsupported,
  };
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Restart fixture failed.");
    process.exit(1);
  });
}
