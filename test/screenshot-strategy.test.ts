import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { File as GeminiFile } from "@google/genai";
import { builtInRecipe, listBuiltInRecipes, loadRecipe, withAnalysisDepth } from "../src/recipes/index.js";
import { AnalysisOrchestrator, type AnalysisProgressEvent, type AnalyzeOptions } from "../src/services/analyze.js";
import type { buildContactSheet } from "../src/services/contact-sheet.js";
import { extractScreenshot } from "../src/services/screenshots.js";

// Only the built-in teaching-points recipe uses the settled-frame screenshot
// search. Every other recipe, and any recipe file, keeps the direct seek.

describe("screenshot strategy in the recipe registry", () => {
  it("is set on built-in teaching-points only", () => {
    for (const recipe of listBuiltInRecipes()) {
      expect(recipe.screenshotStrategy, recipe.id).toBe(recipe.id === "teaching-points" ? "settled" : undefined);
    }
  });

  it("survives the deep profile", async () => {
    const deep = await withAnalysisDepth(await loadRecipe("teaching-points"), "deep");
    expect(deep.recipe.screenshotStrategy).toBe("settled");
  });

  it("cannot be taken by a recipe file, even one reusing the teaching-points id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenshot-strategy-recipe-"));
    try {
      const builtIn = builtInRecipe("teaching-points");
      const path = join(directory, "recipe.json");
      const file = { id: "teaching-points", label: builtIn.label, description: builtIn.description, charter: builtIn.charter };
      await writeFile(path, JSON.stringify(file));
      const loaded = await loadRecipe("teaching-points", path);
      expect(loaded.custom).toBe(true);
      expect(loaded.recipe.screenshotStrategy).toBeUndefined();
      await writeFile(path, JSON.stringify({ ...file, screenshotStrategy: "settled" }));
      await expect(loadRecipe("teaching-points", path)).rejects.toThrow(/unrecognized/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("published screenshot across a low-contrast cut", () => {
  let root: string;
  let video: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "screenshot-strategy-run-"));
    video = join(root, "recording.mp4");
    // Grey 80/82 alternating every frame (never still), then at 2.2 s a cut to
    // a still grey 93: a change of about 12 levels, under the cut threshold.
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=2.2",
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=1.8",
      "-filter_complex",
      "[0]geq=lum='80+2*mod(N\\,2)':cb=128:cr=128[a];[1]geq=lum=93:cb=128:cr=128[b];[a][b]concat=n=2:v=1:a=0,format=yuv420p",
      video,
    ]);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function run(
    flags: { recipe: string; recipeFile?: string },
    screenshot = extractScreenshot,
    extra: { sheet?: typeof buildContactSheet; moments?: number; events?: AnalysisProgressEvent[] } = {},
  ) {
    const { buildAnalyzeOptions } = await import("../src/cli.js");
    const output = await mkdtemp(join(root, "runs-"));
    const options: AnalyzeOptions = await buildAnalyzeOptions(undefined, {
      source: "none", granolaTransport: "mcp", depth: "standard", video, output, maxMoments: "all",
      screenshots: true, derivedTranscript: false, calibrate: false, ...flags,
    }, "synthetic-key");
    const remote: GeminiFile = { name: "files/test", uri: "https://generativelanguage.googleapis.com/v1beta/files/test", mimeType: "video/mp4", state: "ACTIVE" };
    const analyzer = {
      model: "gemini-test",
      upload: vi.fn(async () => remote),
      index: vi.fn(async () => ({
        isRelevantCall: true,
        matchNotes: "Synthetic.",
        transcriptAlignment: { offsetSeconds: 0, confidence: "high" as const, rationale: "Synthetic." },
        moments: Array.from({ length: extra.moments ?? 1 }, () => ({ start: "00:00:00", end: "00:00:04", summary: "A grey picture.", kind: "decision", importance: "high" as const })),
      })),
      interrogate: vi.fn(async () => ({
        accepted: true, kind: "decision", title: "Grey", summary: "A grey picture.",
        evidence: { timestamp: "00:00:02" }, importance: "high" as const,
      })),
      delete: vi.fn(async () => undefined),
    };
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => { throw new Error("no context in a video-only run"); },
      createAnalyzer: () => analyzer as never,
      createRunId: () => "run-test",
      now: () => "2026-11-23T12:00:00.000Z",
      sleep: async () => undefined,
      extractScreenshot: screenshot,
      buildContactSheet: extra.sheet ?? (async () => undefined),
    });
    const result = await orchestrator.analyze(options, {
      progress: { report: (event) => { extra.events?.push(event); } },
    });
    expect(result.analysis.items[0]?.screenshot).toBe("moment-01.png");
    return readFile(join(result.directory, "moment-01.png"));
  }

  async function directSeek(): Promise<Buffer> {
    const destination = join(root, `direct-${Date.now()}.png`);
    expect(await extractScreenshot(video, "00:00:02", destination)).toBe(true);
    return readFile(destination);
  }

  it("a decisions run publishes the same screenshot bytes as the direct seek", async () => {
    expect((await run({ recipe: "decisions" })).equals(await directSeek())).toBe(true);
  });

  it("built-in teaching-points still searches, and here moves to the settled frame", async () => {
    // Shows the clip exercises the search, so the decisions test is not vacuous.
    expect((await run({ recipe: "teaching-points" })).equals(await directSeek())).toBe(false);
  });

  it("a recipe file reusing the teaching-points id takes the direct seek", async () => {
    const builtIn = builtInRecipe("teaching-points");
    const recipeFile = join(root, "teaching-points.json");
    await writeFile(recipeFile, JSON.stringify({ id: "teaching-points", label: builtIn.label, description: builtIn.description, charter: builtIn.charter }));
    const calls: unknown[][] = [];
    const spy: typeof extractScreenshot = async (...args) => {
      calls.push(args);
      return extractScreenshot(...args);
    };
    expect((await run({ recipe: "teaching-points", recipeFile }, spy)).equals(await directSeek())).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
  });

  describe("contact sheet warnings", () => {
    const fakeShot: typeof extractScreenshot = async (_video, _time, destination) => {
      await writeFile(destination, "png");
      return true;
    };
    const sheetWarnings = (events: AnalysisProgressEvent[]) =>
      events.filter((event) => event.kind === "warning" && event.message.includes("contact sheet"));

    it("warns and still completes when the sheet cannot be built", async () => {
      const events: AnalysisProgressEvent[] = [];
      await run({ recipe: "decisions" }, fakeShot, { sheet: async () => undefined, events });
      expect(sheetWarnings(events)).toEqual([expect.objectContaining({
        stage: "rendering",
        message: expect.stringContaining("could not be built"),
      })]);
    });

    it("warns when screenshots are left off the 100-tile sheet", async () => {
      const events: AnalysisProgressEvent[] = [];
      await run({ recipe: "decisions" }, fakeShot, { sheet: async () => "contact-sheet.png", moments: 101, events });
      expect(sheetWarnings(events)).toEqual([expect.objectContaining({
        message: "The contact sheet shows the first 100 of 101 screenshots; the rest are only in the run folder.",
      })]);
    });

    it("stays quiet when every screenshot fits", async () => {
      const events: AnalysisProgressEvent[] = [];
      await run({ recipe: "decisions" }, fakeShot, { sheet: async () => "contact-sheet.png", moments: 3, events });
      expect(sheetWarnings(events)).toEqual([]);
    });
  });
});
