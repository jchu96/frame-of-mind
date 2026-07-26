import { describe, expect, it } from "vitest";
import {
  analysisJobEventSchema,
  analysisJobSchema,
  composerPayloadSchema,
  configurationStatusSchema,
  mediaSessionSchema,
} from "../src/domain/studio-schemas.js";
import {
  ANALYSIS_JOB_STAGES,
  ANALYSIS_JOB_TERMINAL_STAGES,
  assertAnalysisJobTransition,
  resolveIdempotencyReplay,
} from "../src/domain/studio-state.js";

const now = "2026-07-26T21:00:00.000Z";
const later = "2026-07-26T21:01:00.000Z";
const sha256 = "a".repeat(64);
const jobId = "job_01K123456789ABC";
const mediaSessionId = "media_01K123456789";

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    rootJobId: jobId,
    attempt: 1,
    idempotencyKey: "studio-request-0001",
    inputDigest: sha256,
    stage: "queued",
    input: {
      mediaSessionId,
      mediaSha256: sha256,
      context: {
        provider: "bluedot",
        transport: "mcp",
        meetingId: "synthetic-meeting",
      },
      recipe: {
        id: "issue-review",
        revision: "builtin-v1",
        sha256,
      },
      model: "gemini-3.6-flash",
      retention: { mode: "ephemeral" },
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Studio analysis-job state machine", () => {
  it("publishes the exact provider-independent stage and terminal sets", () => {
    expect(ANALYSIS_JOB_STAGES).toEqual([
      "queued",
      "fetching_context",
      "uploading_to_gemini",
      "indexing",
      "interrogating",
      "rendering",
      "cleaning_up",
      "succeeded",
      "failed",
      "canceled",
      "interrupted",
    ]);
    expect(ANALYSIS_JOB_TERMINAL_STAGES).toEqual([
      "succeeded",
      "failed",
      "canceled",
      "interrupted",
    ]);
  });

  it("allows forward execution and routes outcomes through cleanup", () => {
    const legalTransitions = [
      ["queued", "fetching_context"],
      ["fetching_context", "uploading_to_gemini"],
      ["uploading_to_gemini", "indexing"],
      ["indexing", "interrogating"],
      ["interrogating", "rendering"],
      ["rendering", "cleaning_up"],
      ["cleaning_up", "succeeded"],
      ["cleaning_up", "failed"],
      ["cleaning_up", "canceled"],
      ["cleaning_up", "interrupted"],
    ] as const;

    for (const [from, to] of legalTransitions) {
      expect(() => assertAnalysisJobTransition(from, to)).not.toThrow();
    }
  });

  it("allows failure, cancellation, or restart to enter cleanup from active work", () => {
    const activeStages = ANALYSIS_JOB_STAGES.filter(
      (stage) => !ANALYSIS_JOB_TERMINAL_STAGES.includes(stage as never)
        && stage !== "cleaning_up",
    );
    for (const stage of activeStages) {
      expect(() => assertAnalysisJobTransition(stage, "cleaning_up")).not.toThrow();
      expect(() => assertAnalysisJobTransition(stage, "interrupted")).not.toThrow();
    }
  });

  it("rejects skipped, backward, repeated, and terminal transitions", () => {
    const forbiddenTransitions = [
      ["queued", "indexing"],
      ["interrogating", "fetching_context"],
      ["rendering", "rendering"],
      ["succeeded", "queued"],
      ["failed", "cleaning_up"],
      ["canceled", "failed"],
      ["interrupted", "fetching_context"],
    ] as const;

    for (const [from, to] of forbiddenTransitions) {
      expect(() => assertAnalysisJobTransition(from, to)).toThrow(
        `Forbidden analysis-job transition: ${from} -> ${to}`,
      );
    }
  });
});

describe("Studio analysis-job contracts", () => {
  it("accepts an initial attempt and a linked retry", () => {
    expect(analysisJobSchema.parse(job())).toMatchObject({
      attempt: 1,
      rootJobId: jobId,
    });
    expect(analysisJobSchema.parse(job({
      id: "job_01K123456789DEF",
      attempt: 2,
      retryOfJobId: jobId,
      idempotencyKey: "studio-request-0002",
      createdAt: later,
      updatedAt: later,
    }))).toMatchObject({
      attempt: 2,
      retryOfJobId: jobId,
    });
  });

  it("rejects an initial attempt with a parent and a retry without one", () => {
    expect(() => analysisJobSchema.parse(job({
      retryOfJobId: "job_01K123456789DEF",
    }))).toThrow();
    expect(() => analysisJobSchema.parse(job({
      attempt: 2,
      idempotencyKey: "studio-request-0002",
    }))).toThrow();
  });

  it("rejects terminal metadata that contradicts the job stage", () => {
    expect(() => analysisJobSchema.parse(job({
      stage: "succeeded",
      terminal: {
        outcome: "failed",
        at: later,
        code: "analysis_failed",
      },
      updatedAt: later,
    }))).toThrow();
  });

  it("replays the same immutable request and rejects key reuse for different input", () => {
    const existing = {
      jobId,
      idempotencyKey: "studio-request-0001",
      inputDigest: sha256,
    };
    expect(resolveIdempotencyReplay(existing, {
      idempotencyKey: "studio-request-0001",
      inputDigest: sha256,
    })).toEqual({ kind: "replay", jobId });
    expect(() => resolveIdempotencyReplay(existing, {
      idempotencyKey: "studio-request-0001",
      inputDigest: "b".repeat(64),
    })).toThrow(/different immutable input/);
    expect(resolveIdempotencyReplay(undefined, {
      idempotencyKey: "studio-request-0001",
      inputDigest: sha256,
    })).toEqual({ kind: "create" });
  });

  it("validates ordered, bounded progress without requiring a percentage", () => {
    expect(analysisJobEventSchema.parse({
      jobId,
      attempt: 1,
      sequence: 3,
      kind: "progress",
      stage: "indexing",
      occurredAt: now,
      message: "Indexed synthetic frame batch",
      progress: {
        completed: 20,
        total: 100,
        unit: "items",
      },
    })).toMatchObject({
      sequence: 3,
      progress: { completed: 20, total: 100, unit: "items" },
    });
    expect(() => analysisJobEventSchema.parse({
      jobId,
      attempt: 1,
      sequence: 0,
      kind: "progress",
      stage: "indexing",
      occurredAt: now,
    })).toThrow();
    expect(() => analysisJobEventSchema.parse({
      jobId,
      attempt: 1,
      sequence: 3,
      kind: "progress",
      stage: "indexing",
      occurredAt: now,
      progress: { completed: 101, total: 100, unit: "items" },
    })).toThrow();
  });

  it("rejects an event that claims a forbidden transition", () => {
    expect(() => analysisJobEventSchema.parse({
      jobId,
      attempt: 1,
      sequence: 4,
      kind: "transition",
      previousStage: "queued",
      stage: "indexing",
      occurredAt: now,
    })).toThrow(/forbidden/i);
  });
});

describe("Studio boundary schemas", () => {
  it("keeps media state separate and never accepts a client filesystem path", () => {
    expect(mediaSessionSchema.parse({
      id: mediaSessionId,
      status: "sealed",
      expectedBytes: 1_024,
      receivedBytes: 1_024,
      mimeType: "video/mp4",
      sha256,
      retention: { mode: "ephemeral" },
      createdAt: now,
      updatedAt: later,
    })).toMatchObject({ status: "sealed", sha256 });
    expect(() => mediaSessionSchema.parse({
      id: mediaSessionId,
      status: "sealed",
      expectedBytes: 1_024,
      receivedBytes: 1_024,
      mimeType: "video/mp4",
      sha256,
      retention: { mode: "ephemeral" },
      path: "/private/tmp/recording.mp4",
      createdAt: now,
      updatedAt: later,
    })).toThrow();
  });

  it("returns configuration provenance without accepting secret values", () => {
    expect(configurationStatusSchema.parse({
      studioEnabled: false,
      providers: [{
        provider: "gemini",
        connected: true,
        source: "environment",
        lifetime: "process",
        lastVerifiedAt: now,
      }],
    })).toMatchObject({
      providers: [{ source: "environment" }],
    });
    expect(() => configurationStatusSchema.parse({
      studioEnabled: false,
      providers: [{
        provider: "gemini",
        connected: true,
        source: "environment",
        lifetime: "process",
        secret: "must-never-cross-the-api",
      }],
    })).toThrow();
    expect(() => configurationStatusSchema.parse({
      studioEnabled: false,
      providers: [{
        provider: "gemini",
        connected: true,
        source: "session",
        lifetime: "persistent-oauth",
      }],
    })).toThrow();
  });

  it("accepts only opaque composer references, not local paths", () => {
    const payload = {
      idempotencyKey: "studio-request-0001",
      mediaSessionId,
      context: {
        provider: "file",
        transport: "file",
        contextFileId: "context_01K12345678",
      },
      recipe: { id: "issue-review" },
      model: "gemini-3.6-flash",
      retention: { mode: "ephemeral" },
    };
    expect(composerPayloadSchema.parse(payload)).toEqual(payload);
    expect(() => composerPayloadSchema.parse({
      ...payload,
      recordingPath: "/Users/example/recording.mp4",
    })).toThrow();
  });
});
