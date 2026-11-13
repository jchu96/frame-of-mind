import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  derivedTranscript: true,
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

  it("keeps derived transcription on by default and honors the opt-out", async () => {
    const defaulted = await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key");
    expect(defaulted.derivedTranscript).toBe(true);

    const disabled = await buildAnalyzeOptions(undefined, {
      ...baseFlags,
      derivedTranscript: false,
    }, "synthetic-key");
    expect(disabled.derivedTranscript).toBe(false);
  });

  describe("detail concurrency", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("defaults to 1, reads the environment, and lets the flag win", async () => {
      vi.stubEnv("FRAME_OF_MIND_DETAIL_CONCURRENCY", undefined);
      expect((await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key")).detailConcurrency).toBe(1);
      vi.stubEnv("FRAME_OF_MIND_DETAIL_CONCURRENCY", "4");
      expect((await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key")).detailConcurrency).toBe(4);
      expect((await buildAnalyzeOptions(undefined, {
        ...baseFlags,
        concurrency: "8",
      }, "synthetic-key")).detailConcurrency).toBe(8);
    });

    it("rejects values outside 1-8 from the flag or the environment", async () => {
      vi.stubEnv("FRAME_OF_MIND_DETAIL_CONCURRENCY", undefined);
      for (const concurrency of ["0", "9", "1.5", "two", "-1", ""]) {
        await expect(buildAnalyzeOptions(undefined, { ...baseFlags, concurrency }, "synthetic-key"))
          .rejects.toThrow("--concurrency must be an integer from 1 to 8.");
      }
      vi.stubEnv("FRAME_OF_MIND_DETAIL_CONCURRENCY", "12");
      await expect(buildAnalyzeOptions(undefined, baseFlags, "synthetic-key"))
        .rejects.toThrow("FRAME_OF_MIND_DETAIL_CONCURRENCY must be an integer from 1 to 8.");
    });
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

describe("retention validation", () => {
  it("refuses invalid retention before any provider call", async () => {
    await expect(buildAnalyzeOptions(undefined, { ...baseFlags, retention: "idle:2h" }, "synthetic-key"))
      .rejects.toThrow("Upload retention must be");
  });
});

describe("summary", () => {
  it("the first summary line names interrogated, indexed and dropped counts", async () => {
    const { printAnalysisSummary } = await import("../src/cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      printAnalysisSummary({
        directory: "synthetic-run", analysis: { items: [] }, manifest: {},
        outcome: { status: "partial", candidates: { indexed: 57, selected: 10, omittedByLimit: 47, accepted: 0, rejected: 10, validated: 10, failed: 0 } },
      } as Parameters<typeof printAnalysisSummary>[0]);
      expect(stdout.mock.calls.map(([text]) => text).join("").split("\n")[0]).toBe(
        "Interrogated 10 of 57 indexed candidates (47 lower-importance dropped; --max-moments all to analyse every one).",
      );
    } finally { stdout.mockRestore(); }
  });
});

describe("notes", () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  async function noteFile(content: string | Buffer) {
    const root = await mkdtemp(join(tmpdir(), "fom-notes-")); directories.push(root);
    const path = join(root, "reference.md"); await writeFile(path, content); return path;
  }
  it("a 65 KiB note is refused before any provider call", async () => {
    const path = await noteFile("x".repeat(65 * 1024)); const provider = vi.fn();
    await expect(buildAnalyzeOptions(undefined, { ...baseFlags, note: [`brief=${path}`] }, "synthetic-key").then(provider))
      .rejects.toThrow("64 KiB");
    expect(provider).not.toHaveBeenCalled();
  });
  it.each(["bad-name", "duplicate", "nine", "binary", "invalid-utf8"])("refuses %s before any provider call", async kind => {
    const path = await noteFile(kind === "binary" ? Buffer.from([0, 1, 2]) : kind === "invalid-utf8" ? Buffer.from([0xff]) : "reference");
    const note = kind === "bad-name" ? [`BAD=${path}`] : kind === "duplicate" ? [`brief=${path}`, `brief=${path}`]
      : kind === "nine" ? Array.from({ length: 9 }, (_, i) => `note${i}=${path}`) : [`brief=${path}`];
    const provider = vi.fn();
    await expect(buildAnalyzeOptions(undefined, { ...baseFlags, note }, "synthetic-key").then(provider)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });
  it("accepts all as the complete indexed population", async () => {
    const options = await buildAnalyzeOptions(undefined, { ...baseFlags, maxMoments: "all" }, "synthetic-key");
    expect(options.maxIncidents).toBe(1000);
  });
});

describe("clock flags", () => {
  it("rejects invalid declarations before an analyzer can be constructed", async () => {
    for (const flags of [{ timelineOffset: "1.0005" }, { timelineOffset: "-5" }, { timecodeRate: "25" }, { timelineOffset: "0", timecodeRate: "25df" }, { timelineOffset: "0", timecodeRate: "23.98" }, { timelineOffset: "0", timecodeRate: "29.97" }, { fileClock: "clip" }]) {
      await expect(buildAnalyzeOptions(undefined, { ...baseFlags, ...flags }, "synthetic-key")).rejects.toThrow();
    }
  });
  it("passes exact clock declarations and the calibration opt-out", async () => {
    expect(await buildAnalyzeOptions(undefined, { ...baseFlags, timelineOffset: "12.345", timecodeRate: "24000/1001", fileClock: "reel", calibrate: false }, "synthetic-key")).toMatchObject({ timelineOffset: "12.345", timecodeRate: "24000/1001", fileClock: "reel", calibrate: false });
  });
});

describe("thinking level", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  async function rejectValue(value: string) {
    const { GeminiVideoAnalyzer } = await import("../src/adapters/gemini.js");
    const upload = vi.spyOn(GeminiVideoAnalyzer.prototype, "upload").mockRejectedValue(new Error("Unexpected upload"));
    const { program } = await import("../src/cli.js");
    vi.stubEnv("GEMINI_API_KEY", "synthetic-key");
    vi.stubEnv("GEMINI_THINKING_LEVEL", undefined);
    await expect(program.parseAsync(["analyze", "--source", "none", "--video", "package.json", "--thinking-level", value], { from: "user" }))
      .rejects.toThrow("low, medium, high, xhigh");
    vi.stubEnv("GEMINI_THINKING_LEVEL", value);
    await expect(buildAnalyzeOptions(undefined, baseFlags, "synthetic-key"))
      .rejects.toThrow("low, medium, high, xhigh");
    expect(upload).not.toHaveBeenCalled();
  }
  it("minimal is rejected before any upload, naming the four values", async () => {
    await rejectValue("minimal");
  });
  it("MEDIUM and an empty value are rejected before any upload", async () => {
    for (const value of ["MEDIUM", ""]) await rejectValue(value);
  });
  it("--thinking-level low overrides GEMINI_THINKING_LEVEL=high", async () => {
    vi.stubEnv("GEMINI_THINKING_LEVEL", "high");
    const options = await buildAnalyzeOptions(undefined, { ...baseFlags, thinkingLevel: "low" }, "synthetic-key");
    expect(options).toHaveProperty("thinkingLevel", "low");
    expect((await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key")).thinkingLevel).toBe("high");
  });
  it.each(["low", "medium", "high", "xhigh"])("accepts %s and leaves unset absent", async thinkingLevel => {
    vi.stubEnv("GEMINI_THINKING_LEVEL", undefined);
    expect((await buildAnalyzeOptions(undefined, { ...baseFlags, thinkingLevel }, "synthetic-key")).thinkingLevel).toBe(thinkingLevel);
    expect(await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key")).not.toHaveProperty("thinkingLevel");
  });
  it("the summary names model, level and prompt and output tokens and no prompt text", async () => {
    const { printAnalysisSummary } = await import("../src/cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = {
      directory: "synthetic-run", analysis: { items: [], matchNotes: "PRIVATE-SYNTHETIC-PROMPT" },
      manifest: { model: "gemini-test", thinkingLevel: "medium" }, usage: { promptTokens: 123, outputTokens: 45, totalTokens: 168 },
      outcome: { status: "complete", candidates: { indexed: 0, selected: 0, validated: 0, accepted: 0, rejected: 0, failed: 0, omittedByLimit: 0 } },
    } as Parameters<typeof printAnalysisSummary>[0];
    printAnalysisSummary(result);
    const output = stdout.mock.calls.map(([text]) => text).join("");
    expect(output).toContain("Model: gemini-test; thinking level: medium; prompt tokens: 123; output tokens: 45.");
    expect(output).not.toContain("PRIVATE-SYNTHETIC-PROMPT");
    stdout.mockClear();
    delete result.manifest.thinkingLevel; delete result.usage;
    printAnalysisSummary(result);
    expect(stdout.mock.calls.map(([text]) => text).join("")).toContain("Model: gemini-test; thinking level: provider default; usage not reported.");
  });
});

describe("thinking level integration", () => {
  it("the analyze flag reaches the default adapter and its published manifest", async () => {
    const { GeminiVideoAnalyzer } = await import("../src/adapters/gemini.js");
    const { createDefaultAnalysisOrchestrator } = await import("../src/services/analyze.js");
    const root = await mkdtemp(join(tmpdir(), "thinking-cli-"));
    const video = join(root, "synthetic.mp4"); await writeFile(video, "synthetic");
    vi.stubEnv("GEMINI_THINKING_LEVEL", "high");
    vi.spyOn(GeminiVideoAnalyzer.prototype, "upload").mockResolvedValue({ name: "files/synthetic", uri: "https://generativelanguage.googleapis.com/v1beta/files/synthetic", mimeType: "video/mp4" });
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"matchNotes":"Synthetic","moments":[]}' }] } }], usageMetadata: { promptTokenCount: 12, totalTokenCount: 19 } });
    });
    try {
      const options = await buildAnalyzeOptions(undefined, { ...baseFlags, video, output: root, model: "gemini-test", thinkingLevel: "low", calibrate: false, derivedTranscript: false, keepUpload: true }, "synthetic-key");
      const result = await createDefaultAnalysisOrchestrator().analyze(options);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toHaveProperty("generationConfig.thinkingConfig", { thinkingLevel: "low" });
      expect(result.manifest.thinkingLevel).toBe("low");
      expect(result.usage).toEqual({ promptTokens: 12, outputTokens: 7, totalTokens: 19 });
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
});
