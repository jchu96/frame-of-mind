import { test, expect } from "@playwright/test";
import { planStudioMaintenance } from "../../server-local/studio-maintenance/plan";

// REVIEW-fom-75-delta.md: a live worker heartbeat protects an old queued
// sibling and its staged media until a stale-job CAS has actually succeeded.
test("@adversarial maintenance preserves a queued sibling of a live worker", () => {
  const old = "2026-08-20T12:00:00.000Z";
  const plan = planStudioMaintenance({
    now: "2026-08-23T12:00:00.000Z",
    staleJobHorizonMs: 60 * 60 * 1_000,
    orphanGraceMs: 60 * 60 * 1_000,
    heartbeats: [{
      jobId: "job_worker_live",
      observedAt: "2026-08-23T11:59:30.000Z",
    }],
    jobs: [
      {
        id: "job_queued_old",
        stage: "queued",
        updatedAt: old,
        mediaSessionId: "media_queued_old",
      },
      {
        id: "job_worker_live",
        stage: "interrogating",
        updatedAt: old,
        mediaSessionId: "media_worker_live",
      },
    ],
    media: [{
      id: "media_queued_old",
      ownership: "studio_staged_copy",
      status: "sealed",
      retention: { mode: "ephemeral", expiresAt: old },
      updatedAt: old,
      sha256: "a".repeat(64),
    }],
    contextFiles: [],
  });
  expect(plan.actions).toEqual([]);
});
