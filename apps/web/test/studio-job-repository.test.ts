import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  digestImmutableJobInput,
  verifyImmutableJobInput,
} from "../../../src/domain/studio-schemas";
import {
  LocalSqliteJobRepository,
  StudioJobRepositoryError,
} from "../server-local/studio-jobs/sqlite-job-repository";
import { studioJobSchemaSql } from "../server-local/studio-jobs/sql";
import { schemaSql as projectionSchemaSql } from "../server/data/sql";

const temporaryDirectories: string[] = [];
const openDatabases: Database[] = [];
const createdAt = "2026-07-27T12:00:00.000Z";
const oneMinuteLater = "2026-07-27T12:01:00.000Z";
const twoMinutesLater = "2026-07-27T12:02:00.000Z";
const sha256 = "a".repeat(64);
const baseInput = {
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
  focus: "Synthetic test only",
  retention: {
    mode: "ephemeral" as const,
    expiresAt: "2026-07-28T12:00:00.000Z",
  },
};

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("local SQLite job migration", () => {
  test("keeps the checked-in local migration equal to the bootstrap SQL", async () => {
    const migration = await readFile(
      new URL(
        "../server-local/studio-jobs/migrations/0001_jobs.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(normalizeSql(migration)).toBe(normalizeSql(studioJobSchemaSql));
  });

  test("coexists with run projections without adding job tables to D1 parity", () => {
    const database = new Database(":memory:");
    database.exec(projectionSchemaSql);
    const repository = new LocalSqliteJobRepository(database);

    const tables = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(repository).toBeDefined();
    expect(tables).toContain("analysis_runs");
    expect(tables).toContain("studio_analysis_jobs");
    expect(tables).toContain("studio_analysis_job_events");
    expect(projectionSchemaSql).not.toContain("studio_analysis_jobs");
    database.close();
  });
});

describe("LocalSqliteJobRepository", () => {
  test("atomically creates or replays an initial immutable request", async () => {
    const { repository } = createRepository();
    const verifiedInput = await verifyImmutableJobInput(baseInput);
    const first = await repository.createOrReplay({
      idempotencyKey: "request-create-0001",
      verifiedInput,
      createdAt,
    });
    const replay = await repository.createOrReplay({
      idempotencyKey: "request-create-0001",
      verifiedInput,
      createdAt: oneMinuteLater,
    });

    expect(first.kind).toBe("created");
    expect(replay).toEqual({ kind: "replayed", job: first.job });
    expect(first.job).toMatchObject({
      attempt: 1,
      rootJobId: first.job.id,
      stage: "queued",
      inputDigest: verifiedInput.inputDigest,
    });
    expect(await repository.events(first.job.id)).toEqual([]);
  });

  test("serializes idempotent creation across SQLite connections", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "frame-of-mind-job-idempotency-"),
    );
    temporaryDirectories.push(directory);
    const path = join(directory, "studio.sqlite");
    const firstDatabase = new Database(path, { create: true });
    const secondDatabase = new Database(path);
    const firstRepository = new LocalSqliteJobRepository(firstDatabase, {
      createId: () => "job_01K123456789CONN01",
    });
    const secondRepository = new LocalSqliteJobRepository(secondDatabase, {
      createId: () => "job_01K123456789CONN02",
    });
    const verifiedInput = await verifyImmutableJobInput(baseInput);

    const results = await Promise.all([
      firstRepository.createOrReplay({
        idempotencyKey: "request-cross-connection",
        verifiedInput,
        createdAt,
      }),
      secondRepository.createOrReplay({
        idempotencyKey: "request-cross-connection",
        verifiedInput,
        createdAt,
      }),
    ]);

    expect(results.map((result) => result.kind).sort())
      .toEqual(["created", "replayed"]);
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    firstDatabase.close();
    secondDatabase.close();
  });

  test("rejects idempotency-key reuse for different input or retry lineage", async () => {
    const { repository } = createRepository();
    const verifiedInput = await verifyImmutableJobInput(baseInput);
    await repository.createOrReplay({
      idempotencyKey: "request-conflict-0001",
      verifiedInput,
      createdAt,
    });
    const differentInput = await verifyImmutableJobInput({
      ...baseInput,
      mediaSha256: "b".repeat(64),
    });

    await expect(
      repository.createOrReplay({
        idempotencyKey: "request-conflict-0001",
        verifiedInput: differentInput,
        createdAt,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("rejects a forged verified-input digest before inserting a row", async () => {
    const { database, repository } = createRepository();
    const verifiedInput = await verifyImmutableJobInput(baseInput);

    await expect(
      repository.createOrReplay({
        idempotencyKey: "request-forged-digest",
        verifiedInput: {
          ...verifiedInput,
          inputDigest: "b".repeat(64),
        },
        createdAt,
      }),
    ).rejects.toMatchObject({ code: "invalid_input_digest" });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM studio_analysis_jobs",
        )
        .get()?.count,
    ).toBe(0);
  });

  test("requires explicit recipe provenance on newly created jobs", async () => {
    const { repository } = createRepository();
    const { custom: _custom, ...legacyRecipe } = baseInput.recipe;
    const verifiedInput = await verifyImmutableJobInput({
      ...baseInput,
      recipe: legacyRecipe,
    });

    await expect(
      repository.createOrReplay({
        idempotencyKey: "request-missing-recipe-provenance",
        verifiedInput,
        createdAt,
      }),
    ).rejects.toMatchObject({ code: "missing_recipe_provenance" });
  });

  test("still replays a legacy job whose original receipt predates provenance", async () => {
    const { database, repository } = createRepository();
    const created = await createJob(
      repository,
      "request-legacy-replay-0001",
    );
    const { custom: _custom, ...legacyRecipe } = baseInput.recipe;
    const legacy = await verifyImmutableJobInput({
      ...baseInput,
      recipe: legacyRecipe,
    });
    database
      .query<never, [string, string, string]>(
        `UPDATE studio_analysis_jobs
         SET input_json = ?, input_digest = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(legacy.input),
        legacy.inputDigest,
        created.id,
      );

    await expect(
      repository.createOrReplay({
        idempotencyKey: "request-legacy-replay-0001",
        verifiedInput: legacy,
        createdAt: oneMinuteLater,
      }),
    ).resolves.toMatchObject({
      kind: "replayed",
      job: { id: created.id, inputDigest: legacy.inputDigest },
    });
  });

  test("persists legal transitions and assigns ordered event sequences", async () => {
    const { repository } = createRepository();
    const job = await createJob(repository, "request-events-0001");

    const fetching = await repository.transition({
      jobId: job.id,
      expectedStage: "queued",
      nextStage: "fetching_context",
      occurredAt: oneMinuteLater,
      message: "Fetching normalized meeting context.",
    });
    const progress = await repository.appendEvent({
      jobId: job.id,
      attempt: 1,
      kind: "progress",
      stage: "fetching_context",
      occurredAt: twoMinutesLater,
      progress: { completed: 1, total: 2, unit: "steps" },
      message: "Context provider connected.",
    });

    expect(fetching.stage).toBe("fetching_context");
    expect(progress.sequence).toBe(2);
    expect((await repository.events(job.id)).map((event) => event.kind))
      .toEqual(["transition", "progress"]);
    await expect(
      repository.transition({
        jobId: job.id,
        expectedStage: "queued",
        nextStage: "fetching_context",
        occurredAt: twoMinutesLater,
      }),
    ).rejects.toMatchObject({ code: "stage_conflict" });
    await expect(
      repository.appendEvent({
        jobId: job.id,
        attempt: 1,
        kind: "transition",
        previousStage: "fetching_context",
        stage: "uploading_to_gemini",
        occurredAt: twoMinutesLater,
        message: "Bypass atomic transition.",
      }),
    ).rejects.toMatchObject({ code: "event_requires_atomic_operation" });
  });

  test("stores cancellation intent before terminal cancellation", async () => {
    const { repository } = createRepository();
    const job = await createJob(repository, "request-cancel-0001");
    await repository.transition({
      jobId: job.id,
      expectedStage: "queued",
      nextStage: "fetching_context",
      occurredAt: oneMinuteLater,
    });

    const requested = await repository.requestCancellation(
      job.id,
      twoMinutesLater,
    );
    const replayed = await repository.requestCancellation(
      job.id,
      twoMinutesLater,
    );

    expect(requested.cancellationRequestedAt).toBe(twoMinutesLater);
    expect(replayed).toEqual(requested);
    expect((await repository.events(job.id)).at(-1)?.kind)
      .toBe("cancellation_requested");
  });

  test("rejects cancellation after durable run publication", async () => {
    const { repository } = createRepository();
    let job = await createJob(repository, "request-cancel-published-0001");
    const stages = [
      "fetching_context",
      "uploading_to_gemini",
      "indexing",
      "interrogating",
      "rendering",
    ] as const;
    let occurredAt = Date.parse(createdAt);
    for (const nextStage of stages) {
      occurredAt += 60_000;
      job = await repository.transition({
        jobId: job.id,
        expectedStage: job.stage,
        nextStage,
        occurredAt: new Date(occurredAt).toISOString(),
      });
    }
    occurredAt += 60_000;
    job = await repository.transition({
      jobId: job.id,
      expectedStage: "rendering",
      nextStage: "cleaning_up",
      occurredAt: new Date(occurredAt).toISOString(),
      runId: "run_01K123456789ABC",
    });

    await expect(
      repository.requestCancellation(
        job.id,
        new Date(occurredAt + 60_000).toISOString(),
      ),
    ).rejects.toMatchObject({ code: "job_not_cancelable" });
    expect((await repository.get(job.id))?.cancellationRequestedAt)
      .toBeUndefined();
  });

  test("requires terminal run metadata and preserves projection warnings", async () => {
    const { repository } = createRepository();
    let job = await createJob(repository, "request-success-0001");
    const stages = [
      "fetching_context",
      "uploading_to_gemini",
      "indexing",
      "interrogating",
      "rendering",
      "cleaning_up",
    ] as const;
    let occurredAt = Date.parse(createdAt);
    for (const nextStage of stages) {
      occurredAt += 60_000;
      job = await repository.transition({
        jobId: job.id,
        expectedStage: job.stage,
        nextStage,
        occurredAt: new Date(occurredAt).toISOString(),
      });
    }

    await expect(
      repository.transition({
        jobId: job.id,
        expectedStage: "cleaning_up",
        nextStage: "succeeded",
        occurredAt: new Date(occurredAt + 60_000).toISOString(),
      }),
    ).rejects.toThrow();
    const succeeded = await repository.transition({
      jobId: job.id,
      expectedStage: "cleaning_up",
      nextStage: "succeeded",
      occurredAt: new Date(occurredAt + 60_000).toISOString(),
      runId: "run_01K123456789ABC",
      projectionWarning:
        "Published run could not be added to the review projection.",
    });

    expect(succeeded).toMatchObject({
      stage: "succeeded",
      runId: "run_01K123456789ABC",
      projectionWarning:
        "Published run could not be added to the review projection.",
      terminal: { outcome: "succeeded" },
    });
  });

  test("does not let a terminal transition replace a published run ID", async () => {
    const { repository } = createRepository();
    let job = await createJob(repository, "request-published-run-0001");
    const stages = [
      "fetching_context",
      "uploading_to_gemini",
      "indexing",
      "interrogating",
      "rendering",
    ] as const;
    let occurredAt = Date.parse(createdAt);
    for (const nextStage of stages) {
      occurredAt += 60_000;
      job = await repository.transition({
        jobId: job.id,
        expectedStage: job.stage,
        nextStage,
        occurredAt: new Date(occurredAt).toISOString(),
      });
    }
    occurredAt += 60_000;
    job = await repository.transition({
      jobId: job.id,
      expectedStage: "rendering",
      nextStage: "cleaning_up",
      occurredAt: new Date(occurredAt).toISOString(),
      runId: "run_01K123456789ABC",
    });

    await expect(
      repository.transition({
        jobId: job.id,
        expectedStage: "cleaning_up",
        nextStage: "succeeded",
        occurredAt: new Date(occurredAt + 60_000).toISOString(),
        runId: "run_01K123456789DIFFERENT",
      }),
    ).rejects.toMatchObject({ code: "published_run_conflict" });
    expect((await repository.get(job.id))?.runId)
      .toBe("run_01K123456789ABC");
  });

  test("creates linked retries from retryable terminal parents only", async () => {
    const { repository } = createRepository();
    let parent = await createJob(repository, "request-parent-0001");
    parent = await repository.transition({
      jobId: parent.id,
      expectedStage: "queued",
      nextStage: "cleaning_up",
      occurredAt: oneMinuteLater,
    });
    parent = await repository.transition({
      jobId: parent.id,
      expectedStage: "cleaning_up",
      nextStage: "interrupted",
      occurredAt: twoMinutesLater,
      code: "process_restarted",
    });

    const retry = await repository.createLinkedRetry({
      parentJobId: parent.id,
      idempotencyKey: "request-retry-0001",
      createdAt: "2026-07-27T12:03:00.000Z",
    });
    const replay = await repository.createLinkedRetry({
      parentJobId: parent.id,
      idempotencyKey: "request-retry-0001",
      createdAt: "2026-07-27T12:04:00.000Z",
    });

    expect(retry.kind).toBe("created");
    expect(retry.job).toMatchObject({
      attempt: 2,
      retryOfJobId: parent.id,
      rootJobId: parent.id,
      inputDigest: parent.inputDigest,
      stage: "queued",
    });
    expect(replay).toEqual({ kind: "replayed", job: retry.job });
    await expect(
      repository.createLinkedRetry({
        parentJobId: retry.job.id,
        idempotencyKey: "request-retry-too-early",
        createdAt: "2026-07-27T12:05:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "job_not_retryable" });

    let canceledParent = await createJob(repository, "request-canceled-parent-0001");
    canceledParent = await repository.transition({
      jobId: canceledParent.id,
      expectedStage: "queued",
      nextStage: "cleaning_up",
      occurredAt: oneMinuteLater,
    });
    canceledParent = await repository.transition({
      jobId: canceledParent.id,
      expectedStage: "cleaning_up",
      nextStage: "canceled",
      occurredAt: twoMinutesLater,
      code: "operator_canceled",
    });
    await expect(repository.createLinkedRetry({
      parentJobId: canceledParent.id,
      idempotencyKey: "request-canceled-retry-0001",
      createdAt: "2026-07-27T12:03:00.000Z",
    })).rejects.toMatchObject({ code: "job_not_retryable" });
  });

  test("lists stable filtered pages and detects persisted digest corruption", async () => {
    const { database, repository } = createRepository();
    const first = await createJob(
      repository,
      "request-list-0001",
      createdAt,
    );
    const second = await createJob(
      repository,
      "request-list-0002",
      oneMinuteLater,
    );
    await repository.transition({
      jobId: first.id,
      expectedStage: "queued",
      nextStage: "fetching_context",
      occurredAt: twoMinutesLater,
    });

    const pageOne = await repository.list({ limit: 1 });
    const pageTwo = await repository.list({
      limit: 1,
      cursor: pageOne.nextCursor,
    });
    const filtered = await repository.list({
      limit: 10,
      stages: ["fetching_context"],
    });
    const oldest = await repository.list({
      limit: 1,
      order: "oldest",
    });

    expect(pageOne.jobs.map((job) => job.id)).toEqual([second.id]);
    expect(pageTwo.jobs.map((job) => job.id)).toEqual([first.id]);
    expect(filtered.jobs.map((job) => job.id)).toEqual([first.id]);
    expect(oldest.jobs.map((job) => job.id)).toEqual([first.id]);

    database
      .query("UPDATE studio_analysis_jobs SET input_digest = ? WHERE id = ?")
      .run("b".repeat(64), second.id);
    await expect(repository.get(second.id)).rejects.toMatchObject({
      code: "corrupt_job",
    });
    expect(await digestImmutableJobInput(second.input)).toBe(second.inputDigest);
  });

  test("rejects a persisted event bound to the wrong attempt", async () => {
    const { database, repository } = createRepository();
    const job = await createJob(repository, "request-event-attempt-0001");
    await repository.transition({
      jobId: job.id,
      expectedStage: "queued",
      nextStage: "fetching_context",
      occurredAt: oneMinuteLater,
    });
    database.exec("PRAGMA foreign_keys = OFF;");
    database
      .query<never, [number, number, string]>(
        `UPDATE studio_analysis_job_events
         SET attempt = ?, event_json = json_set(event_json, '$.attempt', ?)
         WHERE job_id = ?`,
      )
      .run(2, 2, job.id);
    database.exec("PRAGMA foreign_keys = ON;");

    await expect(repository.events(job.id)).rejects.toMatchObject({
      code: "corrupt_event",
    });
  });

  test("survives a database close and reopen", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "frame-of-mind-job-repository-"),
    );
    temporaryDirectories.push(directory);
    const path = join(directory, "studio.sqlite");
    const firstDatabase = new Database(path, { create: true });
    const firstRepository = new LocalSqliteJobRepository(firstDatabase, {
      createId: () => "job_01K123456789PERSIST",
    });
    const created = await createJob(
      firstRepository,
      "request-persist-0001",
    );
    firstDatabase.close();

    const secondDatabase = new Database(path);
    const secondRepository = new LocalSqliteJobRepository(secondDatabase);
    expect(await secondRepository.get(created.id)).toEqual(created);
    secondDatabase.close();
  });
});

function createRepository() {
  const database = new Database(":memory:");
  openDatabases.push(database);
  const ids = Array.from(
    { length: 20 },
    (_, index) => `job_01K123456789${String(index).padStart(4, "0")}`,
  );
  const repository = new LocalSqliteJobRepository(database, {
    createId: () => ids.shift()!,
  });
  return { database, repository };
}

async function createJob(
  repository: LocalSqliteJobRepository,
  idempotencyKey: string,
  at = createdAt,
) {
  const result = await repository.createOrReplay({
    idempotencyKey,
    verifiedInput: await verifyImmutableJobInput(baseInput),
    createdAt: at,
  });
  return result.job;
}

function normalizeSql(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
