import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type {
  AnalysisJobExecutor,
  JobRepository,
} from "../../../src/domain/studio-ports";
import {
  AnalysisExecutionIndeterminateError,
} from "../../../src/domain/studio-ports";
import {
  verifyImmutableJobInput,
  type AnalysisJob,
} from "../../../src/domain/studio-schemas";
import {
  LocalStudioJobWorker,
  StudioJobWorkerError,
} from "../server-local/studio-jobs/local-job-worker";
import {
  LocalSqliteJobRepository,
} from "../server-local/studio-jobs/sqlite-job-repository";

const databases: Database[] = [];
const baseTime = Date.parse("2026-07-27T12:00:00.000Z");
const sha256 = "a".repeat(64);
const immutableInput = {
  mediaSessionId: "media_01K123456789ABC",
  mediaSha256: sha256,
  context: {
    provider: "bluedot" as const,
    transport: "mcp" as const,
    meetingId: "synthetic-meeting",
  },
  recipe: {
    id: "issue-review",
    custom: false,
    revision: "builtin-v1",
    sha256,
  },
  model: "gemini-3.6-flash",
  retention: {
    mode: "ephemeral" as const,
    expiresAt: "2026-07-28T12:00:00.000Z",
  },
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("LocalStudioJobWorker", () => {
  test("claims and executes queued jobs one at a time in oldest-first order", async () => {
    const { repository } = createRepository();
    const first = await createJob(repository, "worker-oldest-0001", 0);
    const second = await createJob(repository, "worker-oldest-0002", 60_000);
    const clock = createClock();
    const executionOrder: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const executor: AnalysisJobExecutor = {
      async execute(job, { progress }) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        executionOrder.push(job.id);
        await progress.report({
          jobId: job.id,
          attempt: job.attempt,
          kind: "progress",
          stage: "fetching_context",
          occurredAt: clock(),
          progress: { completed: 1, total: 1, unit: "steps" },
          message: "Meeting context is ready.",
        });
        await progress.report({
          jobId: job.id,
          attempt: job.attempt,
          kind: "transition",
          previousStage: "fetching_context",
          stage: "uploading_to_gemini",
          occurredAt: clock(),
          message: "Uploading the staged recording.",
        });
        await progress.report({
          jobId: job.id,
          attempt: job.attempt,
          kind: "transition",
          previousStage: "uploading_to_gemini",
          stage: "cleaning_up",
          occurredAt: clock(),
          message: "Finalizing the durable run.",
        });
        active -= 1;
        return { runId: `run_${job.id}` };
      },
    };
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: clock,
    });

    expect(await worker.start()).toEqual({ interruptedJobIds: [] });
    await worker.whenIdle();

    expect(executionOrder).toEqual([first.id, second.id]);
    expect(maximumActive).toBe(1);
    expect(await repository.get(first.id)).toMatchObject({
      stage: "succeeded",
      runId: `run_${first.id}`,
    });
    expect(await repository.get(second.id)).toMatchObject({
      stage: "succeeded",
      runId: `run_${second.id}`,
    });
    expect((await repository.events(first.id)).map((event) => event.kind))
      .toEqual([
        "transition",
        "progress",
        "transition",
        "transition",
        "transition",
      ]);
  });

  test("persists a sanitized failure without provider error content", async () => {
    const { repository } = createRepository();
    const job = await createJob(repository, "worker-failure-0001", 0);
    const executor: AnalysisJobExecutor = {
      async execute() {
        throw new Error("secret transcript and signed URL");
      },
    };
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: createClock(),
    });

    await worker.start();
    await worker.whenIdle();

    const failed = await repository.get(job.id);
    expect(failed).toMatchObject({
      stage: "failed",
      terminal: {
        code: "analysis_failed",
        message: "Analysis execution failed.",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("secret transcript");
  });

  test("aborts the active job on shutdown and leaves later jobs queued", async () => {
    const { repository } = createRepository();
    const first = await createJob(repository, "worker-shutdown-0001", 0);
    const second = await createJob(repository, "worker-shutdown-0002", 60_000);
    let signalExecutionStarted: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      signalExecutionStarted = resolve;
    });
    const executor: AnalysisJobExecutor = {
      async execute(_job, { signal }) {
        signalExecutionStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
        return { runId: "unreachable" };
      },
    };
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: createClock(),
    });

    await worker.start();
    await executionStarted;
    await worker.shutdown();

    expect(await repository.get(first.id)).toMatchObject({
      stage: "interrupted",
      terminal: { code: "executor_interrupted" },
    });
    expect((await repository.get(second.id))?.stage).toBe("queued");
  });

  test("remembers shutdown requested during startup reconciliation", async () => {
    const { repository } = createRepository();
    const entered = deferred();
    const release = deferred();
    let gated = true;
    const wrapped = proxyRepository(repository, async (query) => {
      if (gated && query.stages?.includes("fetching_context")) {
        gated = false;
        entered.resolve();
        await release.promise;
      }
      return repository.list(query);
    });
    const worker = new LocalStudioJobWorker(
      wrapped,
      successfulExecutor(createClock()),
      { now: createClock() },
    );

    const starting = worker.start();
    await entered.promise;
    const stopping = worker.shutdown();
    release.resolve();
    await Promise.all([starting, stopping]);
    const queued = await createJob(
      repository,
      "worker-stopped-during-start-0001",
      0,
    );
    worker.notify();
    await worker.whenIdle();

    expect((await repository.get(queued.id))?.stage).toBe("queued");
    await expect(worker.start()).rejects.toMatchObject({
      code: "worker_stopped",
    });
  });

  test("does not claim queued work after shutdown starts", async () => {
    const { repository } = createRepository();
    const queued = await createJob(
      repository,
      "worker-stop-before-claim-0001",
      0,
    );
    const entered = deferred();
    const release = deferred();
    let gated = true;
    const wrapped = proxyRepository(repository, async (query) => {
      if (gated && query.stages?.length === 1 && query.stages[0] === "queued") {
        gated = false;
        entered.resolve();
        await release.promise;
      }
      return repository.list(query);
    });
    const worker = new LocalStudioJobWorker(
      wrapped,
      successfulExecutor(createClock()),
      { now: createClock() },
    );

    await worker.start();
    await entered.promise;
    const stopping = worker.shutdown();
    release.resolve();
    await stopping;

    expect((await repository.get(queued.id))?.stage).toBe("queued");
    expect(await repository.events(queued.id)).toEqual([]);
  });

  test("settles a durably canceled queued job without invoking providers", async () => {
    const { repository } = createRepository();
    const job = await createJob(
      repository,
      "worker-canceled-queued-0001",
      0,
    );
    await repository.requestCancellation(
      job.id,
      new Date(baseTime + 60_000).toISOString(),
    );
    let executions = 0;
    const executor: AnalysisJobExecutor = {
      async execute() {
        executions += 1;
        return { runId: "unreachable" };
      },
    };
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: createClock(),
    });

    await worker.start();
    await worker.whenIdle();

    expect(executions).toBe(0);
    expect(await repository.get(job.id)).toMatchObject({
      stage: "canceled",
      terminal: { code: "operator_canceled" },
    });
  });

  test("observes durable cancellation before aborting active execution", async () => {
    const { repository } = createRepository();
    const job = await createJob(
      repository,
      "worker-canceled-active-0001",
      0,
    );
    const started = deferred();
    let eventsAtAbort: string[] = [];
    const executor: AnalysisJobExecutor = {
      async execute(_claimed, { signal }) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", async () => {
            eventsAtAbort = (await repository.events(job.id))
              .map((event) => event.kind);
            reject(new Error("aborted"));
          }, { once: true });
        });
        return { runId: "unreachable" };
      },
    };
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: createClock(),
    });
    await worker.start();
    await started.promise;

    await repository.requestCancellation(
      job.id,
      new Date(baseTime + 20 * 60_000).toISOString(),
    );
    worker.notifyCancellationPersisted(job.id);
    await worker.whenIdle();

    expect(eventsAtAbort).toContain("cancellation_requested");
    expect(await repository.get(job.id)).toMatchObject({
      stage: "canceled",
      terminal: { code: "operator_canceled" },
    });
  });

  test("marks abandoned active jobs interrupted before draining queued work", async () => {
    const { repository } = createRepository();
    const abandoned = await createJob(
      repository,
      "worker-reconcile-0001",
      0,
    );
    await repository.transition({
      jobId: abandoned.id,
      expectedStage: "queued",
      nextStage: "fetching_context",
      occurredAt: new Date(baseTime + 60_000).toISOString(),
    });
    const queued = await createJob(
      repository,
      "worker-reconcile-0002",
      120_000,
    );
    const clock = createClock();
    const executor = successfulExecutor(clock);
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: clock,
    });

    expect(await worker.start()).toEqual({
      interruptedJobIds: [abandoned.id],
    });
    await worker.whenIdle();

    expect(await repository.get(abandoned.id)).toMatchObject({
      stage: "interrupted",
      terminal: { code: "executor_restart" },
    });
    expect(await repository.get(queued.id)).toMatchObject({
      stage: "succeeded",
    });
  });

  test("treats an invalid publication receipt as indeterminate", async () => {
    const { repository } = createRepository();
    const job = await createJob(repository, "worker-invalid-result-0001", 0);
    const executor = {
      async execute() {
        return { runId: "../unsafe" };
      },
    } as AnalysisJobExecutor;
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: createClock(),
    });

    await worker.start();
    await worker.whenIdle();

    expect(await repository.get(job.id)).toMatchObject({
      stage: "interrupted",
      terminal: { code: "executor_result_invalid" },
    });
  });

  test("preserves an executor-reported indeterminate publication outcome", async () => {
    const { repository } = createRepository();
    const job = await createJob(
      repository,
      "worker-indeterminate-error-0001",
      0,
    );
    const executor: AnalysisJobExecutor = {
      async execute() {
        throw new AnalysisExecutionIndeterminateError();
      },
    };
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: createClock(),
    });

    await worker.start();
    await worker.whenIdle();

    expect(await repository.get(job.id)).toMatchObject({
      stage: "interrupted",
      terminal: { code: "executor_result_invalid" },
    });
  });

  test("lets indeterminate publication outrank concurrent cancellation", async () => {
    const { repository } = createRepository();
    const job = await createJob(
      repository,
      "worker-indeterminate-cancel-0001",
      0,
    );
    const started = deferred();
    const finish = deferred();
    const executor: AnalysisJobExecutor = {
      async execute() {
        started.resolve();
        await finish.promise;
        throw new AnalysisExecutionIndeterminateError();
      },
    };
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: createClock(),
    });
    await worker.start();
    await started.promise;

    await repository.requestCancellation(
      job.id,
      new Date(baseTime + 20 * 60_000).toISOString(),
    );
    worker.notifyCancellationPersisted(job.id);
    finish.resolve();
    await worker.whenIdle();

    expect(await repository.get(job.id)).toMatchObject({
      stage: "interrupted",
      terminal: { code: "executor_result_invalid" },
    });
  });

  test("fails closed when executor progress targets another job", async () => {
    const { repository } = createRepository();
    const job = await createJob(repository, "worker-progress-bind-0001", 0);
    const executor: AnalysisJobExecutor = {
      async execute(claimed, { progress }) {
        await progress.report({
          jobId: "job_01K123456789WRONG",
          attempt: claimed.attempt,
          kind: "progress",
          stage: "fetching_context",
          occurredAt: new Date(baseTime + 120_000).toISOString(),
          progress: { completed: 1, total: 1, unit: "steps" },
        });
        return { runId: "unreachable" };
      },
    };
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: createClock(),
    });

    await worker.start();
    await worker.whenIdle();

    expect(await repository.get(job.id)).toMatchObject({
      stage: "failed",
      terminal: { code: "analysis_failed" },
    });
  });

  test("coalesces wakeups and processes jobs created after becoming idle", async () => {
    const { repository } = createRepository();
    const worker = new LocalStudioJobWorker(
      repository,
      successfulExecutor(createClock()),
      { now: createClock() },
    );
    await worker.start();
    await worker.whenIdle();
    const job = await createJob(repository, "worker-later-0001", 0);

    worker.notify();
    worker.notify();
    await worker.whenIdle();

    expect((await repository.get(job.id))?.stage).toBe("succeeded");
    expect(() => worker.notify()).not.toThrow();
  });

  test("rejects a second start", async () => {
    const { repository } = createRepository();
    const worker = new LocalStudioJobWorker(
      repository,
      successfulExecutor(createClock()),
    );
    await worker.start();

    await expect(worker.start()).rejects.toBeInstanceOf(StudioJobWorkerError);
  });
});

function createRepository(): {
  repository: LocalSqliteJobRepository;
} {
  const database = new Database(":memory:");
  databases.push(database);
  let sequence = 0;
  return {
    repository: new LocalSqliteJobRepository(database, {
      createId: () => {
        sequence += 1;
        return `job_01K123456789WORK${String(sequence).padStart(2, "0")}`;
      },
    }),
  };
}

async function createJob(
  repository: JobRepository,
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

function createClock(): () => string {
  let milliseconds = baseTime + 10 * 60_000;
  return () => {
    milliseconds += 1_000;
    return new Date(milliseconds).toISOString();
  };
}

function successfulExecutor(clock: () => string): AnalysisJobExecutor {
  return {
    async execute(job, { progress }) {
      await progress.report({
        jobId: job.id,
        attempt: job.attempt,
        kind: "transition",
        previousStage: "fetching_context",
        stage: "cleaning_up",
        occurredAt: clock(),
        message: "Synthetic execution completed.",
      });
      return { runId: `run_${job.id}` };
    },
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function proxyRepository(
  repository: JobRepository,
  list: JobRepository["list"],
): JobRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "list") return list;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
