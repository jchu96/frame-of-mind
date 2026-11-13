import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { ApiError } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTranscribe } from "../src/commands/transcribe.js";
import { DEFAULT_GEMINI_MODEL, geminiModelSchema } from "../src/adapters/gemini-model.js";
import { buildAnalyzeOptions } from "../src/cli.js";
import { transcribe, type TranscribeOptions } from "../src/services/transcribe.js";
import { AnalysisOrchestrator } from "../src/services/analyze.js";
import { planTranscriptionWindows } from "../src/services/audio.js";
import { formatDerivedTranscript } from "../src/services/transcript.js";
import { renderSrt } from "../src/services/transcript-render.js";
import { timestampToSeconds } from "../src/lib/time.js";
import type { DerivedTranscriptionSegment } from "../src/domain/types.js";

const directories: string[] = [];
const segment = (text = "ZEBRA-SENTINEL-LINE"): DerivedTranscriptionSegment => ({ start: "00:00:20", end: "00:00:24", speaker: "Speaker 1", text });
beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.stubEnv("GEMINI_MODEL", "gemini-test");
  vi.stubEnv("FRAME_OF_MIND_UPLOAD_RETENTION", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture(duration = 1500) {
  const root = await mkdtemp(join(tmpdir(), "fom-transcribe-test-")); directories.push(root);
  const input = join(root, "synthetic.mp4"); await writeFile(input, "synthetic media");
  let uploadNumber = 0;
  const analyzer = {
    model: "gemini-test",
    upload: vi.fn(async (_path: string, _mime: string) => ({ name: `files/synthetic-${++uploadNumber}`, expirationTime: "2026-11-15T00:00:00.000Z" })),
    transcribe: vi.fn(async () => [segment()]),
    delete: vi.fn(async () => {}),
    usageSnapshot: () => ({ promptTokens: 12, outputTokens: 3, totalTokens: 15 }),
  };
  const deps = {
    createAnalyzer: vi.fn(() => analyzer),
    probeDurationSeconds: vi.fn(async (): Promise<number | undefined> => duration),
    extractAudioTrack: vi.fn(async (_input: string, path: string, _options?: { startSeconds?: number; durationSeconds?: number }) => { await writeFile(path, "synthetic audio"); return true; }),
    stdout: vi.fn<(line: string) => void>(), stderr: vi.fn<(line: string) => void>(),
    sleep: vi.fn(async (_ms: number) => {}), now: () => "2026-11-13T00:00:00.000Z",
  };
  const options: TranscribeOptions = { input };
  return { root, input, analyzer, deps, options };
}
async function cli(f: Awaited<ReturnType<typeof fixture>>, flags: string[] = []) {
  const program = new Command().exitOverride(); registerTranscribe(program, f.deps);
  await program.parseAsync(["transcribe", f.input, ...flags], { from: "user" });
}
function failAfterFirst(f: Awaited<ReturnType<typeof fixture>>) {
  f.analyzer.transcribe.mockResolvedValueOnce([segment()]).mockRejectedValue(new ApiError({ message: "synthetic provider denial", status: 403 }));
}
async function expectNoOutputs(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await readdir(f.root)).toEqual(["synthetic.mp4"]);
  for (const [, path] of f.deps.extractAudioTrack.mock.calls) {
    await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
  }
}

describe("retention", () => {
  it("a failure in window 2 reports window 1's kept upload before exiting", async () => {
    const f = await fixture(); failAfterFirst(f);
    await cli(f);
    expect(process.exitCode).toBe(1);
    const messages = f.deps.stderr.mock.calls.map(([line]) => line);
    const kept = messages.findIndex(line => line.includes("kept audio upload: files/synthetic-1"));
    expect(kept).toBeGreaterThanOrEqual(0);
    expect(kept).toBeLessThan(messages.findIndex(line => line.startsWith("error:")));
    expect(messages.filter(line => line.startsWith("kept audio upload:"))).toHaveLength(3);
    expect(f.deps.stderr.mock.invocationCallOrder[0]).toBeLessThan(f.analyzer.transcribe.mock.invocationCallOrder[0]!);
    await expectNoOutputs(f);
  });
  it("--retention run deletes every upload when window 2 fails", async () => {
    const f = await fixture(); failAfterFirst(f);
    await cli(f, ["--retention", "run"]);
    expect(f.analyzer.delete.mock.calls.map(([file]) => file)).toEqual(await Promise.all(f.analyzer.upload.mock.results.map(result => result.value)));
    expect(f.analyzer.delete).toHaveBeenCalledTimes(3); // first window plus both failed attempts
    await expectNoOutputs(f);
  });
  it("with no flag or env no audio upload is deleted", async () => {
    const f = await fixture(); await transcribe(f.options, f.deps);
    expect(f.analyzer.delete).not.toHaveBeenCalled();
    expect(f.deps.stderr.mock.calls.filter(([line]) => line.startsWith("kept audio upload:"))).toHaveLength(3);
  });
  it("resolves environment, explicit flags and aliases without changing the environment", async () => {
    vi.stubEnv("FRAME_OF_MIND_UPLOAD_RETENTION", "run");
    for (const flags of [[], ["--keep-upload"], ["--delete-upload"], ["--retention", "provider"]]) {
      const f = await fixture(10); await cli(f, flags);
      expect(f.analyzer.delete).toHaveBeenCalledTimes(flags.includes("provider") || flags.includes("--keep-upload") ? 0 : 1);
      expect(process.env.FRAME_OF_MIND_UPLOAD_RETENTION).toBe("run");
    }
  });
  it("reports deletion failures and missing expiry without leaking provider bodies", async () => {
    const f = await fixture(10);
    f.analyzer.upload.mockResolvedValue({ name: "files/synthetic", expirationTime: undefined! });
    f.analyzer.delete.mockRejectedValue(new Error("ZEBRA-SENTINEL-LINE"));
    await cli(f, ["--delete-upload"]);
    const stderr = f.deps.stderr.mock.calls.flat().join("\n");
    expect(stderr).toContain("deletion unconfirmed: files/synthetic; expiry: unknown");
    expect(stderr).not.toContain("ZEBRA-SENTINEL-LINE");
  });
});

describe("windows", () => {
  it("two failed attempts on one window write no files and exit non-zero", async () => {
    const f = await fixture(); failAfterFirst(f); await cli(f);
    expect(f.analyzer.transcribe).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);
    await expectNoOutputs(f);
  });
  it("a transient failure on the first attempt is retried once and succeeds", async () => {
    const f = await fixture(10);
    f.analyzer.transcribe.mockRejectedValueOnce(new ApiError({ message: "synthetic 503", status: 503 }));
    await cli(f);
    expect(process.exitCode ?? 0).toBe(0);
    expect(f.analyzer.upload).toHaveBeenCalledTimes(2);
    expect(f.analyzer.transcribe).toHaveBeenCalledTimes(2);
    expect(f.deps.sleep).toHaveBeenCalledExactlyOnceWith(20_000);
    expect(await readFile(join(f.root, "synthetic.srt"), "utf8")).toContain("ZEBRA-SENTINEL-LINE");
  });
  it("window plan equals planTranscriptionWindows with the shared policy after a policy change fixture", async () => {
    vi.resetModules();
    vi.doMock("../src/services/transcription-policy.js", () => ({ TRANSCRIPTION_WINDOW_SECONDS: 400, TRANSCRIPTION_OVERLAP_SECONDS: 9 }));
    try {
      const { transcribe: changedPolicy } = await import("../src/services/transcribe.js");
      const f = await fixture(900); await changedPolicy(f.options, f.deps);
      expect(f.deps.extractAudioTrack.mock.calls.map(([, , options]) => options)).toEqual(
        planTranscriptionWindows(900, 400, 9).map(w => ({ ...(w.startSeconds ? { startSeconds: w.startSeconds } : {}), durationSeconds: w.durationSeconds })),
      );
    } finally { vi.doUnmock("../src/services/transcription-policy.js"); vi.resetModules(); }
  });
  it("matches the analyze ladder for the same two windows and overlap", async () => {
    const f = await fixture(900);
    const chunks = [[{ ...segment("synthetic first"), start: "00:09:56", end: "00:09:59" }],
      [{ ...segment("synthetic overlap"), start: "00:00:11", end: "00:00:14" }, segment("synthetic second")]];
    f.analyzer.transcribe.mockResolvedValueOnce(chunks[0]!).mockResolvedValueOnce(chunks[1]!);
    const result = await transcribe(f.options, f.deps);
    const analyzer = { ...f.analyzer,
      upload: vi.fn(async () => ({ name: "files/synthetic", mimeType: "video/mp4" })),
      transcribe: vi.fn().mockResolvedValueOnce(chunks[0]).mockResolvedValueOnce(chunks[1]),
      index: vi.fn(async () => ({ isRelevantCall: false, matchNotes: "synthetic", moments: [], transcriptAlignment: { offsetSeconds: 0, confidence: "high" as const, rationale: "synthetic" } })),
      interrogate: vi.fn(),
    };
    const orchestrator = new AnalysisOrchestrator({ createContextSource: vi.fn(), createAnalyzer: () => analyzer,
      createRunId: () => "synthetic-run", now: f.deps.now, sleep: f.deps.sleep,
      extractAudioTrack: f.deps.extractAudioTrack, probeDurationSeconds: f.deps.probeDurationSeconds });
    await orchestrator.analyze({ contextMode: "none", video: f.input, outputRoot: join(f.root, "runs"), apiKey: "test-key",
      recipe: { id: "requirements", label: "Synthetic", description: "Synthetic", indexInstruction: "Synthetic", interrogationInstruction: "Synthetic" },
      customRecipe: false, recipeSha256: "a".repeat(64), recipeRevision: "synthetic", maxIncidents: 1, screenshots: false, keepUpload: false });
    expect(analyzer.index.mock.calls[0]![5]).toBe(formatDerivedTranscript(result.segments));
    expect(result.segments.map(s => s.start)).toEqual(["00:09:56", "00:10:05"]);
    expect(f.deps.extractAudioTrack.mock.calls[1]![2]).toEqual({ startSeconds: 585, durationSeconds: 315 });
  });
});

describe("output", () => {
  it("no segment text reaches stdout or stderr", async () => {
    for (const fail of [false, true]) {
      const f = await fixture(); if (fail) failAfterFirst(f); await cli(f);
      expect([...f.deps.stdout.mock.calls, ...f.deps.stderr.mock.calls].flat().join("\n")).not.toContain("ZEBRA-SENTINEL-LINE");
    }
  });
  it("reports blankCues and adjustedCues and writes JSON only when requested", async () => {
    const f = await fixture(10); f.analyzer.transcribe.mockResolvedValue([segment("a"), segment("   "), { ...segment("b"), end: "00:00:19" }]);
    await cli(f, ["--json"]);
    expect(f.deps.stdout.mock.calls.flat().join("\n")).toContain("adjustedCues: 1; blankCues: 1");
    expect(JSON.parse(await readFile(join(f.root, "synthetic.transcript.json"), "utf8"))).toMatchObject({ clock: "source", adjustedCues: 1, blankCues: 1, segments: [{ start: 20 }, { start: 20 }, { start: 20 }] });
    const plain = await fixture(10); await cli(plain);
    expect(await readdir(plain.root)).toEqual(["synthetic.mp4", "synthetic.srt", "synthetic_speakers.txt"]);
  });
});

describe("validation", () => {
  it("uses the adapter default for unset or empty model env and lets the flag override env", async () => {
    for (const env of [undefined, "", "gemini-pro-latest"]) {
      vi.stubEnv("GEMINI_MODEL", env);
      const f = await fixture(10); await transcribe(f.options, f.deps);
      expect(f.deps.createAnalyzer).toHaveBeenCalledExactlyOnceWith("test-key", env || DEFAULT_GEMINI_MODEL);
    }
    vi.stubEnv("GEMINI_MODEL", "gemini-pro-latest");
    const f = await fixture(10); await cli(f, ["--model", "gemini-test"]);
    expect(f.deps.createAnalyzer).toHaveBeenCalledExactlyOnceWith("test-key", "gemini-test");
  });
  it("an invalid --model makes zero uploads", async () => {
    const f = await fixture(); await cli(f, ["--model", "invalid/model"]);
    expect(process.exitCode).toBe(1); expect(f.analyzer.upload).not.toHaveBeenCalled();
  });
  it("the exported model schema and the analyze CLI accept and refuse the same sample ids", async () => {
    const samples = ["gemini-test", "gemini-pro-latest", "gemini-3.7-flash", "gemini-0", "gemini-" + "a".repeat(113), "gemini-" + "a".repeat(114), "gemini-", "gemini-.bad", "gemini-UPPER", "invalid/model", " gemini-test", "gemini-test\n", "models/gemini-test"];
    for (const model of samples) {
      let accepted = true;
      try { await buildAnalyzeOptions(undefined, { source: "none", video: "package.json", recipe: "requirements", depth: "standard", granolaTransport: "mcp", maxMoments: "5", screenshots: false, output: "synthetic-run", model }, "test-key"); }
      catch { accepted = false; }
      expect(geminiModelSchema.safeParse(model).success, model).toBe(accepted);
    }
  });
  it.each(["ffprobe", "audio", "target", "input", "retention"])("refuses %s before uploading", async problem => {
    const f = await fixture(); const flags: string[] = [];
    if (problem === "ffprobe") f.deps.probeDurationSeconds.mockResolvedValue(undefined);
    if (problem === "audio") f.deps.extractAudioTrack.mockResolvedValue(false);
    if (problem === "target") await writeFile(join(f.root, "synthetic.srt"), "old");
    if (problem === "input") await rm(f.input);
    if (problem === "retention") flags.push("--keep-upload", "--delete-upload");
    await cli(f, flags); expect(process.exitCode).toBe(1); expect(f.analyzer.upload).not.toHaveBeenCalled();
    if (["ffprobe", "audio"].includes(problem)) expect(f.deps.stderr.mock.calls.flat().join()).toContain("§6.20");
  });
});

describe("cancellation", () => {
  it("SIGINT during window 2 stops after that window, reports kept uploads and writes no files", async () => {
    const f = await fixture(); const original = process.listenerCount("SIGINT");
    f.analyzer.transcribe.mockResolvedValueOnce([segment()]).mockImplementationOnce(async () => { process.emit("SIGINT"); return [segment()]; });
    await cli(f);
    expect(process.exitCode).toBe(130); expect(f.analyzer.transcribe).toHaveBeenCalledTimes(2);
    expect(f.deps.stderr.mock.calls.filter(([line]) => line.startsWith("kept audio upload:"))).toHaveLength(2);
    expect(process.listenerCount("SIGINT")).toBe(original);
    await expectNoOutputs(f);
  });
});

// Characterisation fixture adopted from the supplied contribution's pure renderer.
function suppliedSrt(segments: DerivedTranscriptionSegment[]) {
  const srtTime = (seconds: number) => {
    const total = Math.max(0, seconds);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(Math.floor(total % 60))},${pad(Math.round((total - Math.floor(total)) * 1000), 3)}`;
  };
  const cues = segments.map((s, index) => {
    const start = timestampToSeconds(s.start); let end = timestampToSeconds(s.end);
    if (!(end > start)) end = start + 1;
    return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${s.text.replace(/\s*[\r\n]+\s*/g, " ").trim()}\n`;
  });
  return `${cues.join("\n")}\n`;
}
describe("characterisation", () => {
  it("clean text renders the supplied SRT bytes", () => {
    const segments = [segment("synthetic alpha"), { ...segment(" synthetic beta "), end: "00:00:18" }];
    expect(renderSrt(segments).text).toBe(suppliedSrt(segments));
  });
  it("SYNTHETIC <marker> TOKEN renders the supplied bytes", () => {
    const segments = [segment("SYNTHETIC <marker> TOKEN")];
    expect(renderSrt(segments).text).toBe(suppliedSrt(segments));
  });
});
