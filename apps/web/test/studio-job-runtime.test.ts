import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type {
  AnalysisJobExecutor,
  RuntimeSecretName,
  RuntimeSecretPresence,
  RuntimeSecretResolver,
} from "../../../src/domain/studio-ports";
import type {
  AnalysisJob,
  ImmutableJobInput,
} from "../../../src/domain/studio-schemas";
import {
  loadRecipe,
} from "../../../src/recipes/index";
import {
  LocalStudioAnalyzeOptionsResolver,
  StudioJobInputUnavailableError,
} from "../server-local/studio-jobs/analysis-options";
import {
  createLocalStudioJobRuntime,
} from "../server-local/studio-jobs/runtime";
import {
  LocalMediaStagingAdapter,
} from "../server-local/studio-media/local-media-staging";

const temporaryRoots: string[] = [];
const databases: Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("Local Studio job runtime", () => {
  test("resolves immutable built-in input to private execution options", async () => {
    const recipe = await loadRecipe("issue-review");
    const mediaPath = "/private/synthetic/media.sealed";
    const resolver = new LocalStudioAnalyzeOptionsResolver({
      media: {
        async resolveInUsePath(id, digest) {
          expect(id).toBe("media_01K123456789ABC");
          expect(digest).toBe("a".repeat(64));
          return mediaPath;
        },
      },
      secrets: secrets({
        "gemini-api-key": "synthetic-gemini-key",
      }),
      oauthCredentialPresent: (provider) => provider === "bluedot",
      outputRoot: "/private/synthetic/runs",
      screenshots: false,
      maxIncidents: 7,
    });
    const job = analysisJob({
      context: {
        provider: "bluedot",
        transport: "mcp",
        meetingId: "meeting-runtime",
      },
      recipe: {
        id: recipe.recipe.id,
        custom: false,
        revision: recipe.revision,
        sha256: recipe.sha256,
      },
    }, { transcriptOffsetSeconds: -3_723 });

    await expect(resolver.resolve(job)).resolves.toMatchObject({
      meetingId: "meeting-runtime",
      contextProvider: "bluedot",
      granolaTransport: "mcp",
      apiKey: "synthetic-gemini-key",
      interactiveProviderAuth: false,
      model: "gemini-3.6-flash",
      video: mediaPath,
      outputRoot: "/private/synthetic/runs",
      maxIncidents: 7,
      screenshots: false,
      keepUpload: false,
      transcriptOffsetSeconds: -3_723,
    });
  });

  test("rejects unavailable custom, file, credential, and transport inputs", async () => {
    const recipe = await loadRecipe("issue-review");
    const resolver = new LocalStudioAnalyzeOptionsResolver({
      media: {
        async resolveInUsePath() {
          throw new Error("must not resolve media for rejected input");
        },
      },
      secrets: secrets({}),
      oauthCredentialPresent: () => false,
      outputRoot: "/private/synthetic/runs",
    });
    const base = immutableInput({
      context: {
        provider: "bluedot",
        transport: "mcp",
        meetingId: "meeting-runtime",
      },
      recipe: {
        id: recipe.recipe.id,
        custom: false,
        revision: recipe.revision,
        sha256: recipe.sha256,
      },
    });

    await expectInputError(resolver.assertReady(base), "gemini_not_configured");
    await expectInputError(resolver.assertReady({
      ...base,
      recipe: { ...base.recipe, custom: true },
    }), "custom_recipe_staging_unavailable");
    const withGemini = new LocalStudioAnalyzeOptionsResolver({
      media: {
        async resolveInUsePath() {
          throw new Error("must not resolve media for rejected input");
        },
      },
      secrets: secrets({ "gemini-api-key": "synthetic-gemini-key" }),
      oauthCredentialPresent: () => false,
      outputRoot: "/private/synthetic/runs",
    });
    await expectInputError(
      withGemini.assertReady(base),
      "bluedot_oauth_not_configured",
    );
    await expectInputError(withGemini.assertReady({
      ...base,
      context: {
        provider: "file",
        transport: "file",
        contextFileId: "context_01K123456789ABC",
        contextFileSha256: "c".repeat(64),
      },
    }), "context_file_staging_unavailable");
    const withMismatchedContext = new LocalStudioAnalyzeOptionsResolver({
      media: {
        async resolveInUsePath() {
          throw new Error("must not resolve media for rejected input");
        },
      },
      contextFiles: {
        async get(id) {
          return {
            id,
            format: "text",
            bytes: 4,
            sha256: "d".repeat(64),
            expiresAt: "2026-07-27T13:00:00.000Z",
          };
        },
        async acquire() {
          throw new Error("must not lease mismatched context");
        },
      },
      secrets: secrets({ "gemini-api-key": "synthetic-gemini-key" }),
      oauthCredentialPresent: () => false,
      outputRoot: "/private/synthetic/runs",
    });
    await expectInputError(withMismatchedContext.assertReady({
      ...base,
      context: {
        provider: "file",
        transport: "file",
        contextFileId: "context_01K123456789ABC",
        contextFileSha256: "c".repeat(64),
      },
    }), "context_file_receipt_mismatch");
    await expectInputError(withGemini.assertReady({
      ...base,
      context: {
        provider: "granola",
        transport: "api",
        meetingId: "not_12345678901234",
      },
    }), "granola_api_not_configured");
  });

  test("leases an exact local context receipt and releases it after execution", async () => {
    const recipe = await loadRecipe("issue-review");
    const releases: string[] = [];
    const contextFileId = "context_01K123456789ABC";
    const resolver = new LocalStudioAnalyzeOptionsResolver({
      media: {
        async resolveInUsePath() {
          return "/private/synthetic/media.sealed";
        },
      },
      contextFiles: {
        async get(id) {
          expect(id).toBe(contextFileId);
          return {
            id,
            format: "vtt",
            bytes: 42,
            sha256: "c".repeat(64),
            expiresAt: "2026-07-27T13:00:00.000Z",
          };
        },
        async acquire(id) {
          expect(id).toBe(contextFileId);
          return {
            path: "/private/synthetic/context.vtt",
            receipt: {
              id,
              format: "vtt",
              bytes: 42,
              sha256: "c".repeat(64),
              expiresAt: "2026-07-27T13:00:00.000Z",
            },
            async release() {
              releases.push(id);
            },
          };
        },
      },
      secrets: secrets({ "gemini-api-key": "synthetic-gemini-key" }),
      oauthCredentialPresent: () => false,
      outputRoot: "/private/synthetic/runs",
    });
    const job = analysisJob({
      context: {
        provider: "file",
        transport: "file",
        contextFileId,
        contextFileSha256: "c".repeat(64),
      },
      recipe: {
        id: recipe.recipe.id,
        custom: false,
        revision: recipe.revision,
        sha256: recipe.sha256,
      },
    });

    await expect(resolver.resolve(job)).resolves.toMatchObject({
      meetingId: contextFileId,
      contextProvider: "file",
      contextFile: "/private/synthetic/context.vtt",
    });
    await resolver.releaseContextFile(job.id);
    await resolver.releaseContextFile(job.id);
    expect(releases).toEqual([contextFileId]);
  });

  test("starts one durable worker and executes API-created work", async () => {
    const root = await mkdtemp(join(tmpdir(), "frame-of-mind-runtime-test-"));
    temporaryRoots.push(root);
    const database = new Database(":memory:");
    databases.push(database);
    const media = new LocalMediaStagingAdapter({
      rootDirectory: join(root, "media"),
      checkoutRoot: process.cwd(),
      partSizeBytes: 20,
      minimumFreeBytes: 0,
      availableBytes: async () => 1_000_000,
      createId: () => "media_01K123456789ABC",
    });
    const fixture = mp4Fixture(20);
    const session = await media.create({
      idempotencyKey: "runtime-media-create-0001",
      expectedBytes: fixture.byteLength,
      mimeType: "video/mp4",
      retention: { mode: "retained", ttlSeconds: 3_600 },
    });
    await media.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: fixture.byteLength,
      bytes: oneChunk(fixture),
    });
    const sealed = await media.seal(session.id, {
      expectedSha256: digest(fixture),
    });
    const recipe = await loadRecipe("issue-review");
    const executor: AnalysisJobExecutor = {
      async execute() {
        return { runId: "run_runtime_01" };
      },
    };
    const runtime = await createLocalStudioJobRuntime({
      database,
      media,
      secrets: secrets({
        "gemini-api-key": "synthetic-gemini-key",
      }),
      oauthCredentialPresent: () => true,
      executor,
      outputRoot: join(root, "runs"),
    });
    const createdAt = new Date().toISOString();
    const result = await runtime.api.create({
      idempotencyKey: "runtime-job-create-0001",
      input: {
        mediaSessionId: session.id,
        mediaSha256: sealed.sha256,
        context: {
          provider: "bluedot",
          transport: "mcp",
          meetingId: "meeting-runtime",
        },
        recipe: {
          id: recipe.recipe.id,
          custom: false,
          revision: recipe.revision,
          sha256: recipe.sha256,
        },
        model: "gemini-3.6-flash",
        retention: session.retention,
      },
    }, createdAt);

    await runtime.worker.whenIdle();
    await expect(runtime.api.detail(result.job.id, {
      afterSequence: 0,
      limit: 100,
    })).resolves.toMatchObject({
      job: {
        stage: "succeeded",
        runId: "run_runtime_01",
      },
      events: [
        { kind: "transition", stage: "fetching_context" },
        { kind: "transition", stage: "cleaning_up" },
        { kind: "transition", stage: "succeeded" },
      ],
    });
    await runtime.shutdown();
  });
});

function secrets(
  values: Partial<Record<RuntimeSecretName, string>>,
): RuntimeSecretResolver {
  return {
    async resolve(name) {
      return values[name];
    },
    async status(name): Promise<RuntimeSecretPresence> {
      return {
        name,
        present: Boolean(values[name]),
        source: values[name] ? "session" : "none",
      };
    },
    async setSession(name, value) {
      values[name] = value;
    },
    async clearSession(name) {
      delete values[name];
    },
  };
}

function immutableInput(
  input: Pick<ImmutableJobInput, "context" | "recipe">,
): ImmutableJobInput {
  return {
    mediaSessionId: "media_01K123456789ABC",
    mediaSha256: "a".repeat(64),
    ...input,
    model: "gemini-3.6-flash",
    retention: {
      mode: "retained",
      expiresAt: "2026-07-28T12:00:00.000Z",
    },
  };
}

function analysisJob(
  input: Pick<ImmutableJobInput, "context" | "recipe">,
  overrides: Partial<ImmutableJobInput> = {},
): AnalysisJob {
  return {
    id: "job_01K123456789ABC",
    rootJobId: "job_01K123456789ABC",
    attempt: 1,
    idempotencyKey: "runtime-options-0001",
    inputDigest: "b".repeat(64),
    stage: "fetching_context",
    input: { ...immutableInput(input), ...overrides },
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T12:00:01.000Z",
  };
}

async function expectInputError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected runtime input error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(StudioJobInputUnavailableError);
    expect((error as StudioJobInputUnavailableError).code).toBe(code);
  }
}

function mp4Fixture(bytes: number): Uint8Array {
  const fixture = new Uint8Array(bytes);
  fixture.set([0x00, 0x00, 0x00, 0x18], 0);
  fixture.set(new TextEncoder().encode("ftypisom"), 4);
  return fixture;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}
