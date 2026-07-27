import { describe, expect, test } from "bun:test";
import type {
  ProgressReporter,
} from "../../../src/domain/studio-ports";
import {
  AnalysisExecutionIndeterminateError,
} from "../../../src/domain/studio-ports";
import {
  analysisJobSchema,
  verifyImmutableJobInput,
  type AnalysisJob,
  type AnalysisJobEvent,
  type MediaSession,
} from "../../../src/domain/studio-schemas";
import type {
  AnalysisRecipe,
} from "../../../src/domain/types";
import { digestRecipe } from "../../../src/recipes/index";
import type {
  AnalysisOrchestrator,
  AnalyzeOptions,
} from "../../../src/services/analyze";
import {
  OrchestratedAnalysisJobExecutor,
} from "../server-local/studio-jobs/orchestrated-job-executor";
import type {
  LocalInitialMediaGuard,
  LocalMediaReuseGuard,
} from "../server-local/studio-jobs/media-reuse-guard";
import { runFixture } from "./fixtures";

const recipe: AnalysisRecipe = {
  id: "issue-review",
  label: "Synthetic issue review",
  description: "Synthetic recipe for executor tests.",
  indexInstruction: "Find the synthetic issue.",
  interrogationInstruction: "Verify the synthetic issue.",
};
const createdAt = "2026-07-27T12:00:00.000Z";

describe("OrchestratedAnalysisJobExecutor", () => {
  test("binds immutable options and translates typed orchestration progress", async () => {
    const job = await claimedJob();
    const events: Array<Omit<AnalysisJobEvent, "sequence">> = [];
    const controller = new AbortController();
    let capturedOptions: AnalyzeOptions | undefined;
    let capturedSignal: AbortSignal | undefined;
    const orchestrator = {
      async analyze(
        options: AnalyzeOptions,
        execution: Parameters<AnalysisOrchestrator["analyze"]>[1],
      ) {
        capturedOptions = options;
        capturedSignal = execution.signal;
        await execution.progress?.report({
          kind: "stage",
          stage: "fetching_context",
          message: "Fetching context.",
        });
        await execution.progress?.report({
          kind: "stage",
          stage: "uploading_to_gemini",
          message: "Uploading.",
        });
        await execution.progress?.report({
          kind: "progress",
          stage: "uploading_to_gemini",
          progress: { completed: 1, total: 2, unit: "steps" },
          message: "Halfway.",
        });
        await execution.progress?.report({
          kind: "warning",
          stage: "uploading_to_gemini",
          message: "Synthetic warning.",
        });
        await execution.progress?.report({
          kind: "stage",
          stage: "cleaning_up",
          message: "Cleaning up.",
        });
        return {
          directory: "/private/not-persisted",
          ...runFixture(),
          projectionWarning:
            "Published run could not be added to the review projection.",
        };
      },
    } as unknown as AnalysisOrchestrator;
    let time = Date.parse(createdAt) + 60_000;
    const executor = new OrchestratedAnalysisJobExecutor({
      orchestrator,
      initialMediaGuard: noOpInitialMediaGuard(),
      now: () => new Date(time += 1_000).toISOString(),
      async resolveAnalyzeOptions() {
        return resolvedOptions({
          meetingId: "wrong-meeting",
          contextProvider: "granola",
          granolaTransport: "api",
          model: "wrong-model",
          focus: "wrong focus",
          recipeRevision: "wrong-revision",
          recipeSha256: "b".repeat(64),
        });
      },
    });

    const result = await executor.execute(job, {
      signal: controller.signal,
      progress: collect(events),
    });

    expect(capturedSignal).toBe(controller.signal);
    expect(capturedOptions).toMatchObject({
      meetingId: "meeting-immutable",
      contextProvider: "bluedot",
      model: "gemini-3.6-flash",
      focus: "Only the reporting request.",
      customRecipe: false,
      recipeRevision: "builtin-v1",
      recipeSha256: job.input.recipe.sha256,
    });
    expect(events.map((event) => [event.kind, event.stage])).toEqual([
      ["transition", "uploading_to_gemini"],
      ["progress", "uploading_to_gemini"],
      ["warning", "uploading_to_gemini"],
      ["transition", "cleaning_up"],
    ]);
    expect(result).toEqual({
      runId: "20260725T120000Z-test",
      projectionWarning:
        "Published run could not be added to the review projection.",
    });
    expect(JSON.stringify(events)).not.toContain("/private/not-persisted");
  });

  test("rejects a recipe that diverges from the immutable receipt", async () => {
    const job = await claimedJob();
    let called = false;
    const orchestrator = {
      async analyze() {
        called = true;
        throw new Error("unreachable");
      },
    } as unknown as AnalysisOrchestrator;
    const executor = new OrchestratedAnalysisJobExecutor({
      orchestrator,
      initialMediaGuard: noOpInitialMediaGuard(),
      async resolveAnalyzeOptions() {
        return {
          ...resolvedOptions(),
          recipe: { ...recipe, label: "Changed after job creation" },
        };
      },
    });

    await expect(
      executor.execute(job, {
        signal: new AbortController().signal,
        progress: collect([]),
      }),
    ).rejects.toThrow("immutable job receipt");
    expect(called).toBe(false);
  });

  test("rejects an orchestration result whose durable contracts diverge", async () => {
    const job = await claimedJob();
    const published = runFixture();
    const orchestrator = {
      async analyze() {
        return {
          directory: "/private/not-persisted",
          analysis: published.analysis,
          manifest: {
            ...published.manifest,
            runId: "different-run",
          },
        };
      },
    } as unknown as AnalysisOrchestrator;
    const executor = new OrchestratedAnalysisJobExecutor({
      orchestrator,
      initialMediaGuard: noOpInitialMediaGuard(),
      resolveAnalyzeOptions: async () => resolvedOptions(),
    });

    await expect(
      executor.execute(job, {
        signal: new AbortController().signal,
        progress: collect([]),
      }),
    ).rejects.toBeInstanceOf(AnalysisExecutionIndeterminateError);
  });

  test("fails closed when a retry has no just-in-time media reuse guard", async () => {
    const parent = await claimedJob();
    const retry = analysisJobSchema.parse({
      ...parent,
      id: "job_01K123456789RETRY",
      rootJobId: parent.id,
      retryOfJobId: parent.id,
      attempt: 2,
      idempotencyKey: "orchestrated-retry-0001",
    });
    let resolved = false;
    const executor = new OrchestratedAnalysisJobExecutor({
      orchestrator: {
        analyze: async () => {
          throw new Error("unreachable");
        },
      } as unknown as AnalysisOrchestrator,
      resolveAnalyzeOptions: async () => {
        resolved = true;
        return resolvedOptions();
      },
    });

    await expect(
      executor.execute(retry, {
        signal: new AbortController().signal,
        progress: collect([]),
      }),
    ).rejects.toMatchObject({ code: "media_reuse_guard_required" });
    expect(resolved).toBe(false);
  });

  test("fails closed when an initial attempt has no media execution guard", async () => {
    const executor = new OrchestratedAnalysisJobExecutor({
      orchestrator: {
        analyze: async () => {
          throw new Error("unreachable");
        },
      } as unknown as AnalysisOrchestrator,
      resolveAnalyzeOptions: async () => resolvedOptions(),
    });

    await expect(
      executor.execute(await claimedJob(), {
        signal: new AbortController().signal,
        progress: collect([]),
      }),
    ).rejects.toMatchObject({ code: "media_initial_guard_required" });
  });

  test("holds and releases the retry media lease around option resolution", async () => {
    const parent = await claimedJob();
    const retry = analysisJobSchema.parse({
      ...parent,
      id: "job_01K123456789LEASE",
      rootJobId: parent.id,
      retryOfJobId: parent.id,
      attempt: 2,
      idempotencyKey: "orchestrated-retry-lease",
    });
    const order: string[] = [];
    let reportedCode: string | undefined;
    const mediaReuseGuard = {
      async acquire() {
        order.push("acquire");
        return {
          session: {} as MediaSession,
          async release() {
            order.push("release");
            throw new Error("synthetic release failure");
          },
        };
      },
    } as LocalMediaReuseGuard;
    const executor = new OrchestratedAnalysisJobExecutor({
      orchestrator: {
        analyze: async () => {
          throw new Error("unreachable");
        },
      } as unknown as AnalysisOrchestrator,
      mediaReuseGuard,
      onMediaLeaseReleaseError: async (error) => {
        reportedCode = error.code;
        order.push("report");
      },
      resolveAnalyzeOptions: async () => {
        order.push("resolve");
        throw new Error("synthetic resolver failure");
      },
    });

    await expect(
      executor.execute(retry, {
        signal: new AbortController().signal,
        progress: collect([]),
      }),
    ).rejects.toThrow("synthetic resolver failure");
    expect(order).toEqual(["acquire", "resolve", "release", "report"]);
    expect(reportedCode).toBe("media_lease_release_failed");
  });

  test("attempts context cleanup before releasing media without masking failure", async () => {
    const order: string[] = [];
    const executor = new OrchestratedAnalysisJobExecutor({
      orchestrator: {
        analyze: async () => {
          throw new Error("unreachable");
        },
      } as unknown as AnalysisOrchestrator,
      initialMediaGuard: {
        async acquire() {
          order.push("media-acquire");
          return {
            session: {} as MediaSession,
            async release() {
              order.push("media-release");
            },
          };
        },
      } as LocalInitialMediaGuard,
      resolveAnalyzeOptions: async () => {
        order.push("resolve");
        throw new Error("synthetic resolver failure");
      },
      releaseContextFile: async () => {
        order.push("context-release");
        throw new Error("private path must not escape");
      },
      onContextFileReleaseError: () => {
        order.push("context-report");
      },
    });

    await expect(
      executor.execute(await claimedJob(), {
        signal: new AbortController().signal,
        progress: collect([]),
      }),
    ).rejects.toThrow("synthetic resolver failure");
    expect(order).toEqual([
      "media-acquire",
      "resolve",
      "context-release",
      "context-report",
      "media-release",
    ]);
  });
});

async function claimedJob(): Promise<AnalysisJob> {
  const verified = await verifyImmutableJobInput({
    mediaSessionId: "media_01K123456789ABC",
    mediaSha256: "a".repeat(64),
    context: {
      provider: "bluedot",
      transport: "mcp",
      meetingId: "meeting-immutable",
    },
    recipe: {
      id: recipe.id,
      custom: false,
      revision: "builtin-v1",
      sha256: await digestRecipe(recipe),
    },
    model: "gemini-3.6-flash",
    focus: "Only the reporting request.",
    retention: {
      mode: "ephemeral",
      expiresAt: "2026-07-28T12:00:00.000Z",
    },
  });
  return analysisJobSchema.parse({
    id: "job_01K123456789ABC",
    rootJobId: "job_01K123456789ABC",
    attempt: 1,
    idempotencyKey: "orchestrated-job-0001",
    inputDigest: verified.inputDigest,
    input: verified.input,
    stage: "fetching_context",
    createdAt,
    updatedAt: createdAt,
  });
}

function resolvedOptions(
  overrides: Partial<AnalyzeOptions> = {},
): AnalyzeOptions {
  return {
    meetingId: "resolved-meeting",
    recipe,
    customRecipe: false,
    recipeSha256: "unused",
    recipeRevision: "unused",
    contextProvider: "file",
    granolaTransport: "mcp",
    contextFile: "/private/context.json",
    apiKey: "test-key",
    model: "unused",
    video: "/private/media.mp4",
    outputRoot: "/private/runs",
    maxIncidents: 10,
    screenshots: true,
    keepUpload: false,
    ...overrides,
  };
}

function noOpInitialMediaGuard(): LocalInitialMediaGuard {
  return {
    async acquire() {
      return {
        session: {} as MediaSession,
        async release() {},
      };
    },
  } as LocalInitialMediaGuard;
}

function collect(
  events: Array<Omit<AnalysisJobEvent, "sequence">>,
): ProgressReporter {
  return {
    async report(event) {
      events.push(event);
    },
  };
}
