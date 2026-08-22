import { describe, expect, test } from "bun:test";
import type {
  AnalysisJob,
  AnalysisJobEvent,
  MediaSession,
} from "../../../src/domain/studio-schemas";
import {
  buildActivityTechnicalDetails,
  formatActivitySupportReceipt,
} from "../server-local/studio-ui/activity-support-receipt";

const jobId = "job_01K123456789ABC";

function adversarialFixture(): {
  job: AnalysisJob;
  events: AnalysisJobEvent[];
  media: MediaSession;
} {
  const job = {
    id: jobId,
    rootJobId: jobId,
    attempt: 1,
    idempotencyKey: "token_support_receipt_should_never_copy",
    inputDigest: "a".repeat(64),
    stage: "failed",
    input: {
      mediaSessionId: "media_01K123456789ABC",
      mediaSha256: "b".repeat(64),
      context: {
        provider: "granola",
        transport: "api",
        meetingId: "not_private_meeting_identifier",
        transcriptOffsetSeconds: 0,
        transcript: "SECRET TRANSCRIPT SENTENCE",
        sourceUrl: "https://private.example/meeting?token=secret",
      },
      recipe: {
        id: "requirements",
        custom: false,
        revision: "builtin-1",
        sha256: "c".repeat(64),
        instruction: "copy the transcript",
      },
      model: "https://provider.example/raw-model-url",
      retention: {
        mode: "retained",
        expiresAt: "2026-08-23T12:00:00.000Z",
      },
      localPath: "/Users/private/recording.mp4",
    },
    terminal: {
      outcome: "failed",
      at: "2026-08-22T12:10:00.000Z",
      code: "gemini_request_failed",
      message: "Raw provider error for owner@example.com with sk-secret-1234567890",
      rawError: { url: "https://provider.example/error?token=secret" },
    },
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:10:00.000Z",
    transcript: "SECRET TRANSCRIPT SENTENCE",
    filePath: "C:\\private\\recording.mp4",
  } as unknown as AnalysisJob;

  const transitions = [
    [1, "queued", "fetching_context", "2026-08-22T12:01:00.000Z"],
    [2, "fetching_context", "uploading_to_gemini", "2026-08-22T12:03:00.000Z"],
    [3, "uploading_to_gemini", "cleaning_up", "2026-08-22T12:08:00.000Z"],
    [4, "cleaning_up", "failed", "2026-08-22T12:10:00.000Z"],
  ] as const;
  const events = transitions.map(([sequence, previousStage, stage, occurredAt]) => ({
    jobId,
    attempt: 1,
    sequence,
    kind: "transition" as const,
    previousStage,
    stage,
    occurredAt,
    message: "SECRET TRANSCRIPT SENTENCE https://private.example/?token=secret",
    providerPayload: { email: "owner@example.com" },
  })) as unknown as AnalysisJobEvent[];

  const media = {
    id: "media_01K123456789ABC",
    status: "cleanup_failed",
    expectedBytes: 24,
    receivedBytes: 24,
    partSizeBytes: 24,
    parts: [],
    mimeType: "video/mp4",
    sha256: "b".repeat(64),
    retention: {
      mode: "retained",
      expiresAt: "2026-08-23T12:00:00.000Z",
    },
    cleanupFailureCode: "permission_denied",
    createdAt: "2026-08-22T11:59:00.000Z",
    updatedAt: "2026-08-22T12:10:00.000Z",
    localPath: "/private/media.sealed",
    providerError: "raw provider error and token-secret-value",
  } as unknown as MediaSession;

  return { job, events, media };
}

describe("local Studio support receipts", () => {
  test("constructs technical details from a closed allowlist", () => {
    const input = adversarialFixture();
    const details = buildActivityTechnicalDetails(input);

    expect(details).toEqual({
      formatVersion: 1,
      jobId,
      stage: "failed",
      terminalCode: "gemini_request_failed",
      timestamps: {
        createdAt: "2026-08-22T12:00:00.000Z",
        updatedAt: "2026-08-22T12:10:00.000Z",
        terminalAt: "2026-08-22T12:10:00.000Z",
        cancellationRequestedAt: null,
      },
      stageDurations: [
        { stage: "queued", seconds: 60 },
        { stage: "fetching_context", seconds: 120 },
        { stage: "uploading_to_gemini", seconds: 300 },
        { stage: "cleaning_up", seconds: 120 },
        { stage: "failed", seconds: 0 },
      ],
      providerId: "granola",
      recipeId: "requirements",
      mediaRetentionState: "retained",
      mediaRetentionExpiresAt: "2026-08-23T12:00:00.000Z",
      cleanupState: "failed",
    });
  });

  test("formats a versioned compact receipt and excludes adversarial private content", () => {
    const input = adversarialFixture();
    const details = buildActivityTechnicalDetails(input);
    const receipt = formatActivitySupportReceipt(details);
    const combined = `${JSON.stringify(details)}\n${receipt}`;

    expect(receipt).toStartWith("Frame of Mind support receipt v1\n");
    expect(receipt).toContain(`job_id=${jobId}`);
    expect(receipt).toContain("stage_duration.uploading_to_gemini_seconds=300");
    expect(receipt).toContain("cleanup_state=failed");
    for (const forbidden of [
      "SECRET TRANSCRIPT SENTENCE",
      "/Users/private/recording.mp4",
      "C:\\private\\recording.mp4",
      "https://private.example",
      "https://provider.example",
      "token_support_receipt_should_never_copy",
      "token-secret-value",
      "sk-secret-1234567890",
      "owner@example.com",
      "raw provider error",
      "not_private_meeting_identifier",
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  test("fails unsafe scalar values closed instead of echoing them", () => {
    const input = adversarialFixture();
    const corrupt = {
      ...input,
      job: {
        ...input.job,
        id: "https://private.example/job?token=secret",
        stage: "raw provider error",
        terminal: {
          ...input.job.terminal,
          code: "owner@example.com",
          at: "not-a-date /Users/private",
        },
        input: {
          ...input.job.input,
          recipe: { ...input.job.input.recipe, id: "https://private.example/recipe" },
        },
      } as unknown as AnalysisJob,
    };

    const details = buildActivityTechnicalDetails(corrupt);
    expect(details.jobId).toBe("unknown");
    expect(details.stage).toBe("unknown");
    expect(details.terminalCode).toBe("none");
    expect(details.timestamps.terminalAt).toBeNull();
    expect(details.recipeId).toBe("unknown");
  });
});
