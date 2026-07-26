import { describe, expect, it } from "vitest";
import type { AnalysisRun } from "../src/domain/types.js";
import { renderAnalysis } from "../src/services/artifacts.js";

describe("analysis Markdown rendering", () => {
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
