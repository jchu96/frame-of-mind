import { describe, expect, it } from "vitest";
import { buildAnalyzeOptions } from "../src/cli.js";

const baseFlags = {
  source: "none",
  granolaTransport: "mcp",
  recipe: "communication-coaching",
  video: "package.json",
  depth: "deep",
  model: "gemini-pro-latest",
  output: ".frame-of-mind/test-runs",
  maxMoments: "5",
  screenshots: false,
};

describe("analyze CLI option assembly", () => {
  it("propagates explicit video-only, deep, and model options", async () => {
    const options = await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key");

    expect(options).toMatchObject({
      contextMode: "none",
      video: "package.json",
      model: "gemini-pro-latest",
      indexFps: 1,
      maxIncidents: 5,
      recipe: { id: "communication-coaching" },
    });
    expect(options.recipeRevision).toContain("deep-understanding-v1");
  });

  it("requires a meeting ID when context is selected", async () => {
    await expect(buildAnalyzeOptions(undefined, {
      ...baseFlags,
      source: "bluedot",
      recipe: "issue-review",
      depth: "standard",
    }, "synthetic-key")).rejects.toThrow("meeting/note ID is required");
  });
});
