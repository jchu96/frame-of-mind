import { describe, expect, test } from "bun:test";
import type { StoredRun } from "../shared/types";
import { versionedRunImportSchema } from "../../../src/domain/schemas";
import {
  buildReviewBundle,
  buildReviewMarkdown,
  reviewBundleFilename,
} from "../server-local/studio-ui/review-export";
import { runFixture } from "./fixtures";

function storedFixture(): StoredRun {
  const fixture = runFixture();
  return {
    schemaVersion: 2,
    contextMode: "meeting",
    runId: fixture.analysis.runId,
    recipeId: fixture.analysis.recipe.id,
    recipeLabel: fixture.analysis.recipe.label,
    model: fixture.analysis.model,
    startedAt: fixture.manifest.startedAt,
    completedAt: fixture.manifest.completedAt,
    acceptedCount: 1,
    rejectedCount: 0,
    importedAt: "2026-07-25T12:02:00.000Z",
    meetingId: fixture.analysis.meeting.id,
    meetingTitle: fixture.analysis.meeting.title,
    provider: fixture.analysis.meeting.provider,
    transport: fixture.manifest.contextTransport,
    matchNotes: fixture.analysis.matchNotes,
    analysis: fixture.analysis,
    manifest: fixture.manifest,
  };
}

describe("Studio review exports", () => {
  test("builds an allowlisted portable pair without projection or injected fields", () => {
    const run = storedFixture() as StoredRun & Record<string, unknown>;
    run.untrustedProjectionField = "not exported";
    (run.analysis as unknown as Record<string, unknown>).untrustedAnalysisField = "not exported";
    (run.manifest as unknown as Record<string, unknown>).untrustedManifestField = "not exported";
    (run.analysis.items[0]!.result as unknown as Record<string, unknown>).raw = "not exported";

    const serialized = JSON.stringify(buildReviewBundle(run));
    expect(serialized).not.toContain("untrusted");
    expect(serialized).not.toContain("not exported");
    expect(Object.keys(buildReviewBundle(run))).toEqual(["analysis", "manifest"]);
    expect(versionedRunImportSchema.safeParse(buildReviewBundle(run)).success).toBe(true);
  });

  test("carries the sanitized outcome into the bundle and Markdown when present", () => {
    const run = storedFixture();
    run.outcome = {
      schemaVersion: 1,
      runId: run.runId,
      status: "partial",
      candidates: {
        indexed: 16,
        selected: 10,
        omittedByLimit: 6,
        validated: 10,
        accepted: 10,
        rejected: 0,
        failed: 0,
      },
      failures: [],
    };

    const bundle = buildReviewBundle(run);
    expect(Object.keys(bundle)).toEqual(["analysis", "manifest", "outcome"]);
    expect((bundle as { outcome?: { status: string } }).outcome?.status).toBe("partial");

    const markdown = buildReviewMarkdown(run);
    expect(markdown).toContain("Outcome: partial");
    expect(markdown).toContain("Partial analysis: 6 of 16 indexed candidate(s) were never interrogated");
  });

  test("renders local Markdown and a deterministic media-free filename", () => {
    const run = storedFixture();
    run.analysis.items[0]!.result.evidence = {
      reporterQuote: "First line\nSecond line",
    };
    const markdown = buildReviewMarkdown(run);
    expect(markdown).toContain("# Product review");
    expect(markdown).toContain("## Accepted: Use the portable contract");
    expect(markdown).toContain("> First line\n> Second line");
    expect(markdown).not.toContain(run.manifest.recordingSha256);
    expect(reviewBundleFilename(run.runId))
      .toBe("frame-of-mind-20260725T120000Z-test.run-bundle.json");
  });
});
