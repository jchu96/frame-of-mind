import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type {
  AnalysisJobExecutor,
  MediaStagingAdapter,
} from "../../../src/domain/studio-ports";
import {
  mediaSessionSchema,
  verifyImmutableJobInput,
  type AnalysisJob,
  type MediaSession,
} from "../../../src/domain/studio-schemas";
import {
  LocalStudioJobControl,
} from "../server-local/studio-jobs/job-control";
import {
  LocalStudioJobWorker,
} from "../server-local/studio-jobs/local-job-worker";
import {
  LocalInitialMediaGuard,
  LocalMediaReuseGuard,
  StudioMediaReuseError,
} from "../server-local/studio-jobs/media-reuse-guard";
import {
  LocalSqliteJobRepository,
} from "../server-local/studio-jobs/sqlite-job-repository";

const databases: Database[] = [];
const createdAt = "2026-07-27T12:00:00.000Z";
const retainedUntil = "2026-07-28T12:00:00.000Z";
const mediaSha256 = "a".repeat(64);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("LocalMediaReuseGuard", () => {
  test("accepts only the exact unexpired retained receipt", async () => {
    const job = await retainedJob();
    const session = retainedSession();
    const guard = new LocalMediaReuseGuard(mediaAdapter(session));

    await expect(
      guard.assertReusable(job, "2026-07-27T13:00:00.000Z"),
    ).resolves.toEqual(session);
  });

  test("rejects changed bytes, expired retention, and non-retained state", async () => {
    const job = await retainedJob();
    const cases: Array<[MediaSession, string]> = [
      [
        retainedSession({ sha256: "b".repeat(64) }),
        "media_digest_mismatch",
      ],
      [
        retainedSession(),
        "media_retention_expired",
      ],
      [
        retainedSession({ status: "sealed" }),
        "media_not_reusable",
      ],
    ];

    for (const [session, code] of cases) {
      const guard = new LocalMediaReuseGuard(mediaAdapter(session));
      const checkedAt = code === "media_retention_expired"
        ? retainedUntil
        : "2026-07-27T13:00:00.000Z";
      await expect(guard.assertReusable(job, checkedAt))
        .rejects.toMatchObject({ code });
    }
  });

  test("leases retained media during retry execution and releases it once", async () => {
    const job = await retainedJob();
    const transitions: string[] = [];
    const guard = new LocalMediaReuseGuard(
      mediaAdapter(retainedSession(), transitions),
    );

    const lease = await guard.acquire(job, "2026-07-27T13:00:00.000Z");
    expect(lease.session.status).toBe("in_use");
    await lease.release();
    await lease.release();

    expect(transitions).toEqual(["retained->in_use", "in_use->retained"]);
  });

  test("retries a transient lease release failure in the live process", async () => {
    const job = await retainedJob();
    const transitions: string[] = [];
    const adapter = mediaAdapter(retainedSession(), transitions);
    const transition = adapter.transition.bind(adapter);
    let releaseAttempts = 0;
    adapter.transition = async (input) => {
      if (
        input.expected === "in_use"
        && input.next === "retained"
        && releaseAttempts++ === 0
      ) {
        throw new Error("synthetic transient release failure");
      }
      return transition(input);
    };
    const guard = new LocalMediaReuseGuard(adapter);

    const lease = await guard.acquire(job, "2026-07-27T13:00:00.000Z");
    await lease.release();

    expect(releaseAttempts).toBe(2);
    expect(transitions).toEqual(["retained->in_use", "in_use->retained"]);
  });
});

describe("LocalInitialMediaGuard", () => {
  test("accepts only the exact unexpired sealed upload receipt", async () => {
    const job = await retainedJob();
    const guard = new LocalInitialMediaGuard(mediaAdapter(
      retainedSession({ status: "sealed" }),
    ));

    await expect(guard.assertUsable(
      job.input,
      "2026-07-27T13:00:00.000Z",
    )).resolves.toBeUndefined();
  });

  test("rejects retained state and a mismatched digest", async () => {
    const job = await retainedJob();
    await expect(
      new LocalInitialMediaGuard(mediaAdapter(retainedSession()))
        .assertUsable(job.input, "2026-07-27T13:00:00.000Z"),
    ).rejects.toMatchObject({ code: "media_not_usable" });
    await expect(
      new LocalInitialMediaGuard(mediaAdapter(retainedSession({
        status: "sealed",
        sha256: "b".repeat(64),
      }))).assertUsable(job.input, "2026-07-27T13:00:00.000Z"),
    ).rejects.toMatchObject({ code: "media_not_usable" });
  });

  test("leases initial retained media and returns it to retained", async () => {
    const job = await retainedJob();
    const transitions: string[] = [];
    const guard = new LocalInitialMediaGuard(mediaAdapter(
      retainedSession({ status: "sealed" }),
      transitions,
    ));

    const lease = await guard.acquire(
      job.input,
      "2026-07-27T13:00:00.000Z",
    );
    await lease.release();

    expect(transitions).toEqual(["sealed->in_use", "in_use->retained"]);
  });

  test("deletes an ephemeral staged copy when its initial lease ends", async () => {
    const job = await retainedJob();
    const transitions: string[] = [];
    const retention = {
      mode: "ephemeral" as const,
      expiresAt: retainedUntil,
    };
    const guard = new LocalInitialMediaGuard(mediaAdapter(
      retainedSession({ status: "sealed", retention }),
      transitions,
    ));

    const lease = await guard.acquire(
      { ...job.input, retention },
      "2026-07-27T13:00:00.000Z",
    );
    await lease.release();

    expect(transitions).toEqual(["sealed->in_use", "in_use->deleted"]);
  });
});

describe("LocalStudioJobControl", () => {
  test("persists cancellation before signaling active execution", async () => {
    const database = new Database(":memory:");
    databases.push(database);
    const repository = new LocalSqliteJobRepository(database, {
      createId: () => "job_01K123456789CANCEL",
    });
    const created = await repository.createOrReplay({
      idempotencyKey: "control-cancel-0001",
      verifiedInput: await verifyImmutableJobInput(retainedInput()),
      createdAt,
    });
    let releaseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let cancellationWasDurableAtAbort = false;
    const executor: AnalysisJobExecutor = {
      async execute(job, { signal }) {
        releaseStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", async () => {
            cancellationWasDurableAtAbort = Boolean(
              (await repository.get(job.id))?.cancellationRequestedAt,
            );
            reject(new Error("aborted"));
          }, { once: true });
        });
        return { runId: "unreachable" };
      },
    };
    const worker = new LocalStudioJobWorker(repository, executor, {
      now: () => "2026-07-27T12:30:00.000Z",
    });
    const control = new LocalStudioJobControl(
      repository,
      worker,
      new LocalMediaReuseGuard(mediaAdapter(retainedSession())),
    );
    await worker.start();
    await started;

    await control.requestCancellation(
      created.job.id,
      "2026-07-27T13:00:00.000Z",
    );
    await worker.whenIdle();

    expect(cancellationWasDurableAtAbort).toBe(true);
    expect((await repository.get(created.job.id))?.stage).toBe("canceled");
  });

  test("creates a linked retry only after validating retained media", async () => {
    const { repository, worker } = runtime();
    const parent = await createRetainedParent(repository);
    const control = new LocalStudioJobControl(
      repository,
      worker,
      new LocalMediaReuseGuard(mediaAdapter(retainedSession())),
    );

    const result = await control.createLinkedRetry({
      parentJobId: parent.id,
      idempotencyKey: "control-retry-0001",
      createdAt: "2026-07-27T13:00:00.000Z",
    });

    expect(result).toMatchObject({
      kind: "created",
      job: {
        retryOfJobId: parent.id,
        rootJobId: parent.id,
        attempt: 2,
      },
    });
  });

  test("does not create a retry when retained media no longer matches", async () => {
    const { database, repository, worker } = runtime();
    const parent = await createRetainedParent(repository);
    const control = new LocalStudioJobControl(
      repository,
      worker,
      new LocalMediaReuseGuard(mediaAdapter(
        retainedSession({ sha256: "b".repeat(64) }),
      )),
    );

    await expect(
      control.createLinkedRetry({
        parentJobId: parent.id,
        idempotencyKey: "control-retry-rejected",
        createdAt: "2026-07-27T13:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(StudioMediaReuseError);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM studio_analysis_jobs",
        )
        .get()?.count,
    ).toBe(1);
  });

  test("replays an existing retry even after retained media becomes unavailable", async () => {
    const { repository, worker } = runtime();
    const parent = await createRetainedParent(repository);
    const input = {
      parentJobId: parent.id,
      idempotencyKey: "control-retry-replay",
      createdAt: "2026-07-27T13:00:00.000Z",
    };
    const initial = new LocalStudioJobControl(
      repository,
      worker,
      new LocalMediaReuseGuard(mediaAdapter(retainedSession())),
    );
    const created = await initial.createLinkedRetry(input);
    const unavailable = new LocalStudioJobControl(
      repository,
      worker,
      new LocalMediaReuseGuard(mediaAdapter(
        retainedSession({ sha256: "b".repeat(64) }),
      )),
    );

    await expect(unavailable.createLinkedRetry(input)).resolves.toEqual({
      kind: "replayed",
      job: created.job,
    });
  });
});

function runtime(): {
  database: Database;
  repository: LocalSqliteJobRepository;
  worker: LocalStudioJobWorker;
} {
  const database = new Database(":memory:");
  databases.push(database);
  let sequence = 0;
  const repository = new LocalSqliteJobRepository(database, {
    createId: () => {
      sequence += 1;
      return `job_01K123456789CTRL${String(sequence).padStart(2, "0")}`;
    },
  });
  const executor: AnalysisJobExecutor = {
    async execute() {
      return { runId: "unreachable" };
    },
  };
  return {
    database,
    repository,
    worker: new LocalStudioJobWorker(repository, executor),
  };
}

async function createRetainedParent(
  repository: LocalSqliteJobRepository,
): Promise<AnalysisJob> {
  const created = await repository.createOrReplay({
    idempotencyKey: "control-parent-0001",
    verifiedInput: await verifyImmutableJobInput(retainedInput()),
    createdAt,
  });
  const cleaning = await repository.transition({
    jobId: created.job.id,
    expectedStage: "queued",
    nextStage: "cleaning_up",
    occurredAt: "2026-07-27T12:01:00.000Z",
  });
  return repository.transition({
    jobId: cleaning.id,
    expectedStage: "cleaning_up",
    nextStage: "failed",
    occurredAt: "2026-07-27T12:02:00.000Z",
    code: "synthetic_failure",
    message: "Synthetic failure.",
  });
}

async function retainedJob(): Promise<AnalysisJob> {
  const verified = await verifyImmutableJobInput(retainedInput());
  return {
    id: "job_01K123456789CTRL00",
    rootJobId: "job_01K123456789CTRL00",
    attempt: 1,
    idempotencyKey: "control-guard-0001",
    inputDigest: verified.inputDigest,
    input: verified.input,
    stage: "failed",
    terminal: {
      outcome: "failed",
      at: "2026-07-27T12:02:00.000Z",
      code: "synthetic_failure",
    },
    createdAt,
    updatedAt: "2026-07-27T12:02:00.000Z",
  };
}

function retainedInput() {
  return {
    mediaSessionId: "media_01K123456789ABC",
    mediaSha256,
    context: {
      provider: "bluedot" as const,
      transport: "mcp" as const,
      meetingId: "synthetic-meeting",
    },
    recipe: {
      id: "issue-review",
      custom: false,
      revision: "builtin-v1",
      sha256: "c".repeat(64),
    },
    model: "gemini-3.6-flash",
    retention: {
      mode: "retained" as const,
      expiresAt: retainedUntil,
    },
  };
}

function retainedSession(
  overrides: Partial<MediaSession> = {},
): MediaSession {
  return mediaSessionSchema.parse({
    id: "media_01K123456789ABC",
    status: "retained",
    expectedBytes: 1024,
    receivedBytes: 1024,
    partSizeBytes: 1024,
    parts: [{
      part: 0,
      offset: 0,
      bytes: 1024,
      sha256: "d".repeat(64),
      receivedAt: "2026-07-27T11:59:00.000Z",
    }],
    mimeType: "video/mp4",
    sha256: mediaSha256,
    retention: {
      mode: "retained",
      expiresAt: retainedUntil,
    },
    createdAt: "2026-07-27T11:58:00.000Z",
    updatedAt: "2026-07-27T12:03:00.000Z",
    ...overrides,
  });
}

function mediaAdapter(
  session: MediaSession,
  transitions: string[] = [],
): MediaStagingAdapter {
  let current = session;
  return {
    async get() {
      return current;
    },
    async transition(input) {
      if (current.status !== input.expected) {
        throw new Error("media state conflict");
      }
      transitions.push(`${input.expected}->${input.next}`);
      current = mediaSessionSchema.parse({
        ...current,
        status: input.next,
        updatedAt: "2026-07-27T13:00:00.000Z",
      });
      return current;
    },
    async delete() {
      if (current.status !== "in_use") {
        throw new Error("media state conflict");
      }
      transitions.push("in_use->deleted");
      current = mediaSessionSchema.parse({
        ...current,
        status: "deleted",
        updatedAt: "2026-07-27T13:00:00.000Z",
      });
      return current;
    },
  } as MediaStagingAdapter;
}
