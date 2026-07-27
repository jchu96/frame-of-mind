import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearStudioJobApi,
  configureStudioJobApi,
  getStudioJobApi,
  RepositoryStudioJobApi,
  resetStudioJobApiForTests,
  StudioJobApiUnavailableError,
  type StudioJobApi,
} from "../server-local/studio-jobs/api-service";
import {
  parseJobEventQuery,
  parseJobListQuery,
} from "../server-local/studio-jobs/query";
import {
  LocalSqliteJobRepository,
} from "../server-local/studio-jobs/sqlite-job-repository";

const databases: Database[] = [];

afterEach(() => {
  resetStudioJobApiForTests();
  for (const database of databases.splice(0)) database.close();
});

describe("Local Studio job HTTP contracts", () => {
  test("bounds list filters and rejects duplicate or invalid query values", () => {
    expect(parseJobListQuery({})).toEqual({
      limit: 25,
      order: "newest",
    });
    expect(parseJobListQuery({
      limit: "100",
      order: "oldest",
      stage: "queued,failed,queued",
      cursor: "opaque-cursor",
    })).toEqual({
      limit: 100,
      order: "oldest",
      stages: ["queued", "failed"],
      cursor: "opaque-cursor",
    });
    expect(() => parseJobListQuery({ limit: "0" })).toThrow();
    expect(() => parseJobListQuery({ limit: "101" })).toThrow();
    expect(() => parseJobListQuery({ limit: ["10", "20"] })).toThrow();
    expect(() => parseJobListQuery({ cursor: "" })).toThrow();
    expect(() => parseJobListQuery({ stage: "" })).toThrow();
    expect(() => parseJobListQuery({
      stage: "queued,failed,canceled,interrupted,succeeded",
    })).toThrow();
  });

  test("bounds event history independently from job summaries", () => {
    expect(parseJobEventQuery({})).toEqual({
      afterSequence: 0,
      limit: 100,
    });
    expect(parseJobEventQuery({ after: "42", limit: "25" })).toEqual({
      afterSequence: 42,
      limit: 25,
    });
    expect(() => parseJobEventQuery({ after: "-1" })).toThrow();
    expect(() => parseJobEventQuery({ limit: "0" })).toThrow();
    expect(() => parseJobEventQuery({ limit: "101" })).toThrow();
  });

  test("fails closed until exactly one process runtime is configured", () => {
    expect(() => getStudioJobApi())
      .toThrow(StudioJobApiUnavailableError);
    const api = {} as StudioJobApi;
    configureStudioJobApi(api);
    configureStudioJobApi(api);
    expect(getStudioJobApi()).toBe(api);
    expect(() => configureStudioJobApi({} as StudioJobApi))
      .toThrow("already configured");
    clearStudioJobApi({} as StudioJobApi);
    expect(getStudioJobApi()).toBe(api);
    clearStudioJobApi(api);
    expect(() => getStudioJobApi()).toThrow(StudioJobApiUnavailableError);
  });

  test("creates or replays once and keyset-pages bounded event history", async () => {
    const database = new Database(":memory:");
    databases.push(database);
    const repository = new LocalSqliteJobRepository(database, {
      createId: () => "job_01K123456789HTTP01",
    });
    let validations = 0;
    let notifications = 0;
    const api = new RepositoryStudioJobApi(
      repository,
      {
        requestCancellation: (jobId, requestedAt) =>
          repository.requestCancellation(jobId, requestedAt),
        createLinkedRetry: (input) => repository.createLinkedRetry(input),
      },
      { notify: () => notifications += 1 },
      {
        async validateInitialInput() {
          validations += 1;
        },
      },
    );
    const request = {
      idempotencyKey: "job-http-create-0001",
      input: immutableInput(),
    };

    const created = await api.create(request, "2026-07-27T12:00:00.000Z");
    const replayed = await api.create(request, "2026-07-27T12:01:00.000Z");
    await repository.transition({
      jobId: created.job.id,
      expectedStage: "queued",
      nextStage: "fetching_context",
      occurredAt: "2026-07-27T12:02:00.000Z",
    });
    await repository.transition({
      jobId: created.job.id,
      expectedStage: "fetching_context",
      nextStage: "uploading_to_gemini",
      occurredAt: "2026-07-27T12:03:00.000Z",
    });

    expect(created.kind).toBe("created");
    expect(replayed).toEqual({ kind: "replayed", job: created.job });
    expect(validations).toBe(1);
    expect(notifications).toBe(1);
    await expect(api.detail(created.job.id, {
      afterSequence: 0,
      limit: 1,
    })).resolves.toMatchObject({
      job: { id: created.job.id },
      events: [{ sequence: 1 }],
      nextAfterSequence: 1,
    });
    await expect(api.detail(created.job.id, {
      afterSequence: 1,
      limit: 1,
    })).resolves.toMatchObject({
      events: [{ sequence: 2 }],
    });
  });
});

function immutableInput() {
  return {
    mediaSessionId: "media_01K123456789ABC",
    mediaSha256: "a".repeat(64),
    context: {
      provider: "bluedot" as const,
      transport: "mcp" as const,
      meetingId: "meeting-http",
    },
    recipe: {
      id: "issue-review",
      custom: false,
      revision: "builtin-v1",
      sha256: "b".repeat(64),
    },
    model: "gemini-3.6-flash",
    retention: {
      mode: "ephemeral" as const,
      expiresAt: "2026-07-28T12:00:00.000Z",
    },
  };
}
