import { describe, expect, it } from "vitest";
import {
  MAX_RETAINED_MEDIA_TTL_SECONDS,
  analysisJobEventSchema,
  analysisJobSchema,
  composerPayloadSchema,
  configurationStatusSchema,
  digestImmutableJobInput,
  jobCancelRequestSchema,
  jobCreateRequestSchema,
  jobRetryRequestSchema,
  meetingCatalogRequestSchema,
  mediaSessionSchema,
  validateAnalysisJob,
  verifyImmutableJobInput,
} from "../src/domain/studio-schemas.js";
import {
  ANALYSIS_JOB_STAGES,
  ANALYSIS_JOB_TERMINAL_STAGES,
  assertAnalysisJobTransition,
  assertMediaSessionTransition,
  resolveIdempotencyReplay,
  validateMediaSessionTransition,
} from "../src/domain/studio-state.js";

const now = "2026-07-26T21:00:00.000Z";
const later = "2026-07-26T21:01:00.000Z";
const sha256 = "a".repeat(64);
const jobId = "job_01K123456789ABC";
const mediaSessionId = "media_01K123456789";
const immutableInput = {
  mediaSessionId,
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
  transcriptOffsetSeconds: 3_723,
  retention: { mode: "ephemeral" as const, expiresAt: later },
};
const canonicalInputDigest = await digestImmutableJobInput(immutableInput);

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    rootJobId: jobId,
    attempt: 1,
    idempotencyKey: "studio-request-0001",
    inputDigest: canonicalInputDigest,
    stage: "queued",
    input: immutableInput,
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

describe("Studio media-session state machine", () => {
  it("accepts the complete ADR media lifecycle and rejects resurrection", () => {
    const legalTransitions = [
      ["created", "uploading"],
      ["uploading", "sealed"],
      ["sealed", "in_use"],
      ["in_use", "retained"],
      ["retained", "in_use"],
      ["created", "aborted"],
      ["retained", "expired"],
      ["expired", "deleting"],
      ["deleting", "deleted"],
      ["deleting", "cleanup_failed"],
      ["cleanup_failed", "deleting"],
      ["uploading", "failed"],
    ] as const;
    for (const [from, to] of legalTransitions) {
      expect(() => assertMediaSessionTransition(from, to)).not.toThrow();
    }

    for (const [from, to] of [
      ["deleted", "uploading"],
      ["failed", "deleting"],
      ["created", "retained"],
      ["sealed", "uploading"],
    ] as const) {
      expect(() => assertMediaSessionTransition(from, to)).toThrow(
        `Forbidden media-session transition: ${from} -> ${to}`,
      );
    }
  });

  it("creates a validated transition receipt for adapters", () => {
    expect(validateMediaSessionTransition({
      id: mediaSessionId,
      expected: "sealed",
      next: "in_use",
    })).toMatchObject({
      id: mediaSessionId,
      expected: "sealed",
      next: "in_use",
    });
    expect(() => validateMediaSessionTransition({
      id: mediaSessionId,
      expected: "deleted",
      next: "uploading",
    })).toThrow(/forbidden media-session transition/i);
    expect(() => validateMediaSessionTransition({
      id: "../../private/file",
      expected: "sealed",
      next: "in_use",
    })).toThrow(/opaque and route-safe/);
  });
});

describe("Studio analysis-job contracts", () => {
  it("accepts an initial attempt and a linked retry synchronously", () => {
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

  it("rejects durable run metadata on failed, canceled, or interrupted jobs", () => {
    for (const stage of ["failed", "canceled", "interrupted"] as const) {
      expect(() => analysisJobSchema.parse(job({
        stage,
        runId: "run_01K123456789ABC",
        terminal: {
          outcome: stage,
          at: later,
        },
        updatedAt: later,
      }))).toThrow(/durable run/);
    }
  });

  it("requires a published run before recording a projection warning", () => {
    expect(() => analysisJobSchema.parse(job({
      stage: "cleaning_up",
      projectionWarning:
        "Published run could not be added to the review projection.",
      updatedAt: later,
    }))).toThrow(/published run/);
  });

  it("binds the stored input digest to canonical immutable input", async () => {
    const verified = await verifyImmutableJobInput(immutableInput);
    expect(verified.inputDigest).toBe(canonicalInputDigest);
    await expect(validateAnalysisJob(job({
      inputDigest: "b".repeat(64),
    }))).rejects.toThrow(/canonical SHA-256/);
  });

  it("keeps pre-executor job receipts readable without recipe provenance", async () => {
    const legacyInput = {
      ...immutableInput,
      recipe: {
        id: immutableInput.recipe.id,
        revision: immutableInput.recipe.revision,
        sha256: immutableInput.recipe.sha256,
      },
    };
    const verified = await verifyImmutableJobInput(legacyInput);

    await expect(validateAnalysisJob({
      ...job(),
      input: verified.input,
      inputDigest: verified.inputDigest,
    })).resolves.toMatchObject({
      input: { recipe: { id: "issue-review" } },
    });
  });

  it("replays the same immutable request and rejects key reuse for different input", () => {
    const existing = {
      jobId,
      idempotencyKey: "studio-request-0001",
      inputDigest: canonicalInputDigest,
    };
    expect(resolveIdempotencyReplay(existing, {
      idempotencyKey: "studio-request-0001",
      inputDigest: canonicalInputDigest,
    })).toEqual({ kind: "replay", jobId });
    expect(() => resolveIdempotencyReplay(existing, {
      idempotencyKey: "studio-request-0001",
      inputDigest: "b".repeat(64),
    })).toThrow(/different immutable input/);
    expect(resolveIdempotencyReplay(undefined, {
      idempotencyKey: "studio-request-0001",
      inputDigest: canonicalInputDigest,
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
      message: "Skipped required work",
    })).toThrow(/forbidden/i);
  });

  it("keeps event-kind metadata mutually exclusive and structured", () => {
    expect(() => analysisJobEventSchema.parse({
      jobId,
      attempt: 1,
      sequence: 5,
      kind: "warning",
      stage: "indexing",
      occurredAt: now,
      message: "Provider response was incomplete",
      progress: { completed: 1, total: 2, unit: "items" },
    })).toThrow();
    expect(() => analysisJobEventSchema.parse({
      jobId,
      attempt: 1,
      sequence: 6,
      kind: "transition",
      previousStage: "queued",
      stage: "fetching_context",
      occurredAt: now,
    })).toThrow();
  });
});

describe("Studio boundary schemas", () => {
  it("keeps media state separate and never accepts a client filesystem path", () => {
    expect(mediaSessionSchema.parse({
      id: mediaSessionId,
      status: "sealed",
      expectedBytes: 1_024,
      receivedBytes: 1_024,
      partSizeBytes: 1_024,
      parts: [{
        part: 0,
        offset: 0,
        bytes: 1_024,
        sha256,
        receivedAt: later,
      }],
      mimeType: "video/mp4",
      sha256,
      retention: { mode: "ephemeral", expiresAt: later },
      createdAt: now,
      updatedAt: later,
    })).toMatchObject({ status: "sealed", sha256 });
    expect(() => mediaSessionSchema.parse({
      id: mediaSessionId,
      status: "sealed",
      expectedBytes: 1_024,
      receivedBytes: 1_024,
      partSizeBytes: 1_024,
      parts: [{
        part: 0,
        offset: 0,
        bytes: 1_024,
        sha256,
        receivedAt: later,
      }],
      mimeType: "video/mp4",
      sha256,
      retention: { mode: "ephemeral", expiresAt: later },
      path: "/private/tmp/recording.mp4",
      createdAt: now,
      updatedAt: later,
    })).toThrow();
    expect(() => mediaSessionSchema.parse({
      id: mediaSessionId,
      status: "retained",
      expectedBytes: 1_024,
      receivedBytes: 1_024,
      partSizeBytes: 1_024,
      parts: [{
        part: 0,
        offset: 0,
        bytes: 1_024,
        sha256,
        receivedAt: later,
      }],
      mimeType: "video/mp4",
      sha256,
      retention: { mode: "ephemeral", expiresAt: later },
      createdAt: now,
      updatedAt: later,
    })).toThrow(/retained receipt/);
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
    expect(() => configurationStatusSchema.parse({
      studioEnabled: false,
      providers: [{
        provider: "gemini",
        connected: true,
        source: "oauth",
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
        contextFileSha256: "c".repeat(64),
      },
      recipe: { id: "issue-review" },
      model: "gemini-3.6-flash",
      transcriptOffsetSeconds: -3_723,
      retention: { mode: "ephemeral" },
    };
    expect(composerPayloadSchema.parse(payload)).toEqual(payload);
    expect(() => composerPayloadSchema.parse({
      ...payload,
      recordingPath: "/Users/example/recording.mp4",
    })).toThrow();
    expect(() => composerPayloadSchema.parse({
      ...payload,
      transcriptOffsetSeconds: Number.POSITIVE_INFINITY,
    })).toThrow();
    expect(() => composerPayloadSchema.parse({
      ...payload,
      retention: {
        mode: "retained",
        ttlSeconds: MAX_RETAINED_MEDIA_TTL_SECONDS + 1,
      },
    })).toThrow();
  });

  it("keeps meeting catalog requests on an exact provider transport", () => {
    expect(meetingCatalogRequestSchema.parse({
      provider: "bluedot",
      transport: "mcp",
      cursor: "2",
      limit: 8,
    })).toEqual({
      provider: "bluedot",
      transport: "mcp",
      cursor: "2",
      limit: 8,
    });
    expect(() => meetingCatalogRequestSchema.parse({
      provider: "bluedot",
      transport: "api",
      limit: 8,
    })).toThrow();
    expect(() => meetingCatalogRequestSchema.parse({
      provider: "bluedot",
      transport: "mcp",
      cursor: "../private",
      limit: 8,
    })).toThrow();
  });

  it("keeps job mutation bodies strict and server-timestamped", () => {
    expect(jobCreateRequestSchema.parse({
      idempotencyKey: "studio-job-create-0001",
      input: immutableInput,
    })).toEqual({
      idempotencyKey: "studio-job-create-0001",
      input: immutableInput,
    });
    expect(jobRetryRequestSchema.parse({
      idempotencyKey: "studio-job-retry-0001",
    })).toEqual({
      idempotencyKey: "studio-job-retry-0001",
    });
    expect(jobCancelRequestSchema.parse({})).toEqual({});
    expect(() => jobCancelRequestSchema.parse({
      requestedAt: now,
    })).toThrow();
    expect(() => jobCreateRequestSchema.parse({
      idempotencyKey: "studio-job-create-0001",
      input: {
        ...immutableInput,
        recipe: {
          id: "issue-review",
          revision: "builtin-v1",
          sha256,
        },
      },
    })).toThrow();
    expect(() => jobCreateRequestSchema.parse({
      idempotencyKey: "studio-job-create-0001",
      input: immutableInput,
      filesystemPath: "/private/recording.mp4",
    })).toThrow();
  });
});
