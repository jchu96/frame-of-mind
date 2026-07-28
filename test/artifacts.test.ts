import { describe, expect, it } from "vitest";
import type {
  AnalysisRun,
  AnalysisRunV3,
} from "../src/domain/types.js";
import { renderAnalysis } from "../src/services/artifacts.js";

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
});
