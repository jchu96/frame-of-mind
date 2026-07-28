import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AnalysisRun,
  AnalysisRunV3,
  RunManifestV3,
} from "../src/domain/types.js";
import { renderAnalysis, writeArtifacts } from "../src/services/artifacts.js";
import { analysisOutcomeSchema } from "../src/domain/analysis-outcome.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("analysis Markdown rendering", () => {
  it("labels video-only provenance without inventing a meeting", () => {
    const analysis: AnalysisRunV3 = {
      schemaVersion: 3,
      runId: "video-only",
      recipe: { id: "issue-review", label: "Issue review" },
      context: { mode: "none" },
      model: "gemini-test",
      matchNotes: "Recording-only analysis.",
      items: [],
    };

    const markdown = renderAnalysis(analysis);
    expect(markdown).toContain("# Video analysis");
    expect(markdown).toContain("Context: Video only (no external context)");
    expect(markdown).not.toContain("Meeting:");
  });

  it("renders recipe-neutral details and escapes untrusted Markdown", () => {
    const analysis: AnalysisRun = {
      schemaVersion: 2,
      runId: "run-test",
      recipe: { id: "decisions", label: "Decisions" },
      meeting: { id: "meeting-1", provider: "file", title: "Review <script>" },
      model: "gemini-test",
      matchNotes: "Matched.",
      items: [{
        candidate: {
          start: "00:00:10",
          end: "00:00:20",
          kind: "decision",
          summary: "Choose an option",
          importance: "high",
        },
        result: {
          accepted: true,
          kind: "decision",
          title: "Use **option A**",
          summary: "The team selected A.",
          details: [{ label: "Rationale", value: "Safer | faster" }],
          evidence: { timestamp: "00:00:12", reporterQuote: "Let's use A." },
        },
      }],
    };
    const markdown = renderAnalysis(analysis);
    expect(markdown).toContain("Recipe: `decisions`");
    expect(markdown).toContain("Rationale");
    expect(markdown).toContain("Safer \\| faster");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
  });

  it("renders a prominent partial-result warning from sanitized diagnostics", () => {
    const analysis: AnalysisRunV3 = {
      schemaVersion: 3,
      runId: "partial-run",
      recipe: { id: "requirements", label: "Requirements" },
      context: { mode: "none" },
      model: "gemini-test",
      matchNotes: "Synthetic match.",
      items: [],
    };
    const outcome = analysisOutcomeSchema.parse({
      schemaVersion: 1,
      runId: analysis.runId,
      status: "failed",
      candidates: {
        indexed: 3,
        selected: 1,
        omittedByLimit: 2,
        validated: 0,
        accepted: 0,
        rejected: 0,
        failed: 1,
      },
      failures: [{
        candidateOrdinal: 1,
        start: "00:00:01",
        end: "00:00:02",
        code: "invalid_json",
        attempts: 2,
      }],
    });

    const markdown = renderAnalysis(analysis, outcome);
    expect(markdown).toContain("Analysis outcome: failed");
    expect(markdown).toContain("failed validation and were excluded");
    expect(markdown).toContain("analysis-outcome.json");
  });

  it("rejects diagnostic statuses that contradict candidate counts", () => {
    expect(() => analysisOutcomeSchema.parse({
      schemaVersion: 1,
      runId: "invalid-outcome",
      status: "complete",
      candidates: {
        indexed: 1,
        selected: 1,
        omittedByLimit: 0,
        validated: 0,
        accepted: 0,
        rejected: 0,
        failed: 1,
      },
      failures: [{
        candidateOrdinal: 1,
        start: "00:00:01",
        end: "00:00:02",
        code: "invalid_json",
        attempts: 2,
      }],
    })).toThrow();
  });

  it("rejects impossible failure ordinals, ranges, duplicates, and issue metadata", () => {
    const base = {
      schemaVersion: 1 as const,
      runId: "invalid-failures",
      status: "failed" as const,
      candidates: {
        indexed: 2,
        selected: 2,
        omittedByLimit: 0,
        validated: 0,
        accepted: 0,
        rejected: 0,
        failed: 2,
      },
    };
    expect(() => analysisOutcomeSchema.parse({
      ...base,
      failures: [
        {
          candidateOrdinal: 3,
          start: "00:00:02",
          end: "00:00:01",
          code: "invalid_json",
          attempts: 2,
          issues: [{ path: "where.surface", code: "too_big" }],
        },
        {
          candidateOrdinal: 3,
          start: "00:00:03",
          end: "00:00:04",
          code: "response_missing",
          attempts: 2,
        },
      ],
    })).toThrow();
  });

  it("binds outcome counts to analysis items and renders the HTML failure banner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-artifacts-"));
    temporaryDirectories.push(directory);
    const analysis: AnalysisRunV3 = {
      schemaVersion: 3,
      runId: "failed-html",
      recipe: { id: "requirements", label: "Requirements" },
      context: { mode: "none" },
      model: "gemini-test",
      matchNotes: "Synthetic match.",
      items: [],
    };
    const outcome = analysisOutcomeSchema.parse({
      schemaVersion: 1,
      runId: analysis.runId,
      status: "failed",
      candidates: {
        indexed: 1,
        selected: 1,
        omittedByLimit: 0,
        validated: 0,
        accepted: 0,
        rejected: 0,
        failed: 1,
      },
      failures: [{
        candidateOrdinal: 1,
        start: "00:00:01",
        end: "00:00:02",
        code: "invalid_json",
        attempts: 2,
      }],
    });
    const manifest: RunManifestV3 = {
      schemaVersion: 3,
      toolVersion: "0.3.0",
      promptRevision: "synthetic",
      runId: analysis.runId,
      startedAt: "2026-07-28T12:00:00.000Z",
      completedAt: "2026-07-28T12:01:00.000Z",
      context: { mode: "none" },
      recipe: {
        id: analysis.recipe.id,
        label: analysis.recipe.label,
        custom: false,
        revision: "synthetic",
        sha256: "a".repeat(64),
      },
      model: analysis.model,
      recordingSha256: "b".repeat(64),
      analysisSha256: "c".repeat(64),
      recordingMimeType: "video/mp4",
      mediaSource: "local-file",
      analysis: {
        maxIncidents: 1,
        indexFps: 0.5,
        indexResolution: "low",
        interrogationResolution: "medium",
      },
      artifacts: ["analysis.json", "analysis-outcome.json", "analysis.md", "report.html", "manifest.json"],
    };

    await writeArtifacts(directory, analysis, manifest, outcome);
    expect(await readFile(join(directory, "report.html"), "utf8"))
      .toContain("Analysis failed");

    await expect(writeArtifacts(directory, analysis, manifest, {
      ...outcome,
      status: "complete",
      candidates: {
        indexed: 1,
        selected: 1,
        omittedByLimit: 0,
        validated: 1,
        accepted: 1,
        rejected: 0,
        failed: 0,
      },
      failures: [],
    })).rejects.toThrow("Analysis items and outcome candidate counts must match");
  });
});
