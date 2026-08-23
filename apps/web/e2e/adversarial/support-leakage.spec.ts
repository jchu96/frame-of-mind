import { test, expect } from "@playwright/test";
import type {
  AnalysisJob,
  AnalysisJobEvent,
  MediaSession,
} from "../../../../src/domain/studio-schemas";
import {
  buildActivityTechnicalDetails,
  formatActivitySupportReceipt,
} from "../../server-local/studio-ui/activity-support-receipt";
import { adversarialStrings } from "../support/fixtures";

// REVIEW-fom-74.md: technical details and support receipts are fresh closed
// projections, never filtered copies of private job/media/provider objects.
test("@adversarial support receipt excludes technical-detail trap strings", () => {
  const job = {
    id: "job_e2e_support_0001",
    rootJobId: "job_e2e_support_0001",
    attempt: 1,
    idempotencyKey: adversarialStrings.oauthToken,
    inputDigest: "a".repeat(64),
    stage: "failed",
    input: {
      mediaSessionId: "media_e2e_support_0001",
      mediaSha256: "b".repeat(64),
      context: {
        provider: "granola",
        transport: "api",
        meetingId: "not_fixture_private_meeting",
        transcript: adversarialStrings.transcript,
        sourceUrl: adversarialStrings.signedUrl,
      },
      recipe: { id: "requirements", custom: false, revision: "fixture", sha256: "c".repeat(64) },
      model: "fixture-model",
      retention: { mode: "retained", expiresAt: "2036-08-23T00:00:00.000Z" },
      localPath: adversarialStrings.posixPath,
    },
    terminal: {
      outcome: "failed",
      at: "2026-08-23T12:10:00.000Z",
      code: "gemini_request_failed",
      message: adversarialStrings.providerError,
    },
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:10:00.000Z",
    filePath: adversarialStrings.windowsPath,
  } as unknown as AnalysisJob;
  const events = [{
    jobId: job.id,
    attempt: 1,
    sequence: 1,
    kind: "transition",
    previousStage: "queued",
    stage: "failed",
    occurredAt: "2026-08-23T12:10:00.000Z",
    message: adversarialStrings.transcript,
  }] as unknown as AnalysisJobEvent[];
  const media = {
    id: "media_e2e_support_0001",
    status: "cleanup_failed",
    expectedBytes: 1,
    receivedBytes: 1,
    partSizeBytes: 1,
    parts: [],
    mimeType: "video/mp4",
    sha256: "b".repeat(64),
    retention: { mode: "retained", expiresAt: "2036-08-23T00:00:00.000Z" },
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:10:00.000Z",
    providerError: adversarialStrings.providerError,
  } as unknown as MediaSession;
  const details = buildActivityTechnicalDetails({ job, events, media });
  const output = `${JSON.stringify(details)}\n${formatActivitySupportReceipt(details)}`;
  for (const forbidden of Object.values(adversarialStrings)) {
    expect(output).not.toContain(forbidden);
  }
});
