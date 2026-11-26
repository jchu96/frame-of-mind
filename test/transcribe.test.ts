import { FileContextSource } from "../src/adapters/file-context.js";
import { validateCliDocument } from "./helpers/cli-schema.js";
import { createHash } from "node:crypto";
import { calibrateClipClock } from "../src/adapters/gemini-calibration.js";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { ApiError, type GenerateContentParameters } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTranscribe } from "../src/commands/transcribe.js";
import { DEFAULT_GEMINI_MODEL, geminiModelSchema } from "../src/adapters/gemini-model.js";
import { buildAnalyzeOptions } from "../src/cli.js";
import { transcribe, type TranscribeOptions } from "../src/services/transcribe.js";
import { AnalysisOrchestrator } from "../src/services/analyze.js";
import { planTranscriptionWindows, type decodeSpeechEnvelope } from "../src/services/audio.js";
import { formatDerivedTranscript } from "../src/services/transcript.js";
import { renderSrt } from "../src/services/transcript-render.js";
import { secondsToTimestamp, timestampToSeconds } from "../src/lib/time.js";
import type { DerivedTranscriptionSegment } from "../src/domain/types.js";
import { GeminiVideoAnalyzer } from "../src/adapters/gemini.js";
import { GeminiHostedAnalysisProvider, resolveHostedTranscript } from "../apps/workflows/src/provider.js";
import { expectOriginalLanguage, requestText } from "./helpers/transcription-request.js";

vi.mock("../src/services/media-capabilities.js", () => ({ requireMedia: async () => {} }));

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
function cue(start: number, end: number, text: string) {
  return { ...segment(text), start: secondsToTimestamp(start), end: secondsToTimestamp(end) };
}

// Alternate one second of tone and one of silence on the decoder's 10 ms grid.
function soundTrack(seconds: number, ...bursts: [start: number, count: number][]) {
  const length = seconds * 100;
  const levels = new Float32Array(length).fill(-96);
  for (const [start, count] of bursts) {
    for (let i = 0; i < count; i++) levels.fill(-10, start * 100 + i * 200, start * 100 + i * 200 + 100);
  }
  const blocks = [];
  for (let i = 0; i < length; i += 1000) blocks.push(levels.subarray(i, i + 1000));
  return { startMs: 0, length, blocks };
}

async function fixture(duration = 1500) {
  const root = await mkdtemp(join(tmpdir(), "fom-transcribe-test-")); directories.push(root);
  const input = join(root, "synthetic.mp4"); await writeFile(input, "synthetic media");
  let uploadNumber = 0;
  const analyzer = {
    model: "gemini-test",
    upload: vi.fn(async (_path: string, _mime: string) => ({ name: `files/synthetic-${++uploadNumber}`, expirationTime: "2026-11-15T00:00:00.000Z" })),
    transcribe: vi.fn(async () => [{ ...segment(), start: "00:00:02", end: "00:00:04" }]),
    delete: vi.fn(async () => {}),
    usageSnapshot: () => ({ promptTokens: 12, outputTokens: 3, totalTokens: 15 }),
  };
  const deps = {
    createAnalyzer: vi.fn(() => analyzer),
    decodeSpeechEnvelope: vi.fn<typeof decodeSpeechEnvelope>().mockResolvedValue(soundTrack(duration)),
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
  it("retries a 615 s window with minutes in the hours field, then writes no transcript", async () => {
    const f = await fixture(1200);
    f.analyzer.transcribe.mockResolvedValueOnce([{ ...segment(), end: "00:10:02" }])
      .mockResolvedValueOnce([segment(), { ...segment(), start: "09:50:17", end: "09:51:23" }])
      .mockResolvedValueOnce([segment(), { ...segment(), end: "09:51:23" }]);
    await cli(f, ["--json"]);
    expect(JSON.parse(f.deps.stdout.mock.lastCall![0])).toMatchObject({ error: { code: "COMMAND_FAILED" } });
    expect(process.exitCode).toBe(1);
    expect(f.analyzer.transcribe).toHaveBeenCalledTimes(3);
    expect(f.deps.sleep).toHaveBeenCalledExactlyOnceWith(20_000);
    expect(f.deps.stderr.mock.calls.flat().slice(-2)).toEqual([
      "error: Transcription failed on window 2 after 2 attempts; no transcript files written.",
      "A transcript time fell outside audio window 2.",
    ]);
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

describe("original-language transcription", () => {
  const syntheticArabic = { start: "00:09:55", end: "00:09:57", speaker: "Speaker １", text: "هل هذا واضح؟" };
  const syntheticChinese = { start: "00:09:58", end: "00:10:00", speaker: "Speaker 2", text: "现在开始。" };
  const syntheticMixed = { start: "00:00:16", end: "00:00:18", speaker: "Speaker 2", text: "看这里 < ثم هنا。" };
  const merged = [syntheticArabic, syntheticChinese, { ...syntheticMixed, start: "00:10:01", end: "00:10:03" }];
  const lines = [
    `[00:09:55] Speaker １: ${syntheticArabic.text}`,
    `[00:09:58] Speaker 2: ${syntheticChinese.text}`,
    `[00:10:01] Speaker 2: ${syntheticMixed.text}`,
  ].join("\n");
  const windows = [{ segments: [syntheticArabic, syntheticChinese] }, { segments: [syntheticMixed] }];

  function capture(...responses: unknown[]) {
    const requests: GenerateContentParameters[] = [];
    const analyzer = new GeminiVideoAnalyzer("test-key", "gemini-test", {
      generateContent: async request => {
        requests.push(request);
        const call = requests.length;
        return {
          text: JSON.stringify(responses[call - 1]),
          usageMetadata: { promptTokenCount: 10 * call, totalTokenCount: 11 * call },
        };
      },
    });
    vi.spyOn(analyzer, "upload").mockImplementation(async (_path, mimeType) => ({
      name: "files/synthetic", uri: "https://example.invalid/files/synthetic", mimeType,
    }));
    vi.spyOn(analyzer, "delete").mockResolvedValue(undefined);
    return { analyzer, requests };
  }

  it.each([undefined, "fr-ca"])("captures both standalone windows and exported provenance for hint %s", async transcriptLanguage => {
    const f = await fixture(900);
    const { analyzer, requests } = capture(...windows);
    const program = new Command().exitOverride();
    registerTranscribe(program, { ...f.deps, createAnalyzer: () => analyzer });
    await program.parseAsync(["transcribe", f.input, "--json", ...(transcriptLanguage ? ["--transcript-language", transcriptLanguage] : [])], { from: "user" });
    const expectedTag = transcriptLanguage ? "fr-CA" : undefined;
    expect(requests).toHaveLength(2);
    for (const [index, request] of requests.entries()) {
      if (!expectedTag) {
        // Pin both complete requests, including the different audio durations.
        expect(createHash("sha256").update(JSON.stringify(request)).digest("hex")).toBe([
          "c29479ae1faf471700673d2b602acb284e2af76210103969afcaac3f1b6b9dc2",
          "bcb36722010ced8ef6439794b256fcc0952fbf137074c68c8d233e16f35f35ea",
        ][index]);
      }
      expectOriginalLanguage(request, "initial", expectedTag, [600, 315][index]);
    }
    const [srt, speakers, json] = await Promise.all(["synthetic.srt", "synthetic_speakers.txt", "synthetic.transcript.json"]
      .map(name => readFile(join(f.root, name), "utf8")));
    expect(srt).toBe([
      `1\n00:09:55,000 --> 00:09:57,000\n${syntheticArabic.text}`,
      `2\n00:09:58,000 --> 00:10:00,000\n${syntheticChinese.text}`,
      `3\n00:10:01,000 --> 00:10:03,000\n${syntheticMixed.text}`,
      "",
    ].join("\n\n"));
    expect(speakers).toBe("# frame-of-mind transcript; origin: gemini-audio; model: gemini-test; clock: source; timing: reference-grade (whole-second)" + (expectedTag ? "; requestedLanguage: fr-CA" : "") + "\n" + lines + "\n");
    const exported = JSON.parse(json!);
    expect(exported).not.toHaveProperty("detectedLanguage");
    if (expectedTag) expect(exported.requestedLanguage).toBe(expectedTag);
    else expect(exported).not.toHaveProperty("requestedLanguage");
    expect(JSON.parse(json!).segments).toEqual([
      { ...syntheticArabic, start: 595, end: 597 },
      { ...syntheticChinese, start: 598, end: 600 },
      { ...syntheticMixed, start: 601, end: 603 },
    ]);
  });

  it.each([undefined, "fr-ca"])("captures analyze-derived windows, calibration, index and detail for hint %s", async transcriptLanguage => {
    const f = await fixture(900);
    const candidate = { start: "00:09:58", end: "00:10:03", kind: "test", summary: "Synthetic", importance: "low" };
    const { analyzer, requests } = capture({ seconds: 27 }, ...windows,
      { matchNotes: "Synthetic", moments: [candidate] },
      { accepted: true, kind: "test", title: "Synthetic", summary: "Synthetic", evidence: { timestamp: candidate.start } },
    );
    const orchestrator = new AnalysisOrchestrator({
      ...f.deps, createContextSource: vi.fn(), createAnalyzer: () => analyzer,
      calibrateClipClock: provider => calibrateClipClock(provider, { cacheRoot: f.root, synthesize: async () => true }),
    });
    const result = await orchestrator.analyze({
      contextMode: "none", video: f.input, outputRoot: join(f.root, "runs"), apiKey: "test-key",
      recipe: { id: "requirements", label: "Synthetic", description: "Synthetic", indexInstruction: "Synthetic", interrogationInstruction: "Synthetic" },
      customRecipe: false, recipeSha256: "a".repeat(64), recipeRevision: "synthetic", maxIncidents: 1,
      screenshots: false, keepUpload: false, transcriptLanguage,
    });
    expect(requests).toHaveLength(5);
    expect(analyzer.measuredUsageByPass()?.calibration).toEqual({ promptTokens: 10, outputTokens: 1, totalTokens: 11 });
    const expectedTag = transcriptLanguage ? "fr-CA" : undefined;
    expectOriginalLanguage(requests[1]!, "initial", expectedTag, 600);
    expectOriginalLanguage(requests[2]!, "initial", expectedTag, 315);
    for (const request of [requests[0], requests[3], requests[4]]) {
      expect(JSON.stringify(request)).not.toContain("fr-CA");
    }
    expect(result.manifest.derivedTranscript).toBeDefined();
    if (expectedTag) expect(result.manifest.derivedTranscript?.requestedLanguage).toBe(expectedTag);
    else expect(result.manifest.derivedTranscript).not.toHaveProperty("requestedLanguage");
    const escaped = lines.replace("<", "&lt;");
    expect(requestText(requests[3]!).match(/<transcript>\n([\s\S]*?)\n<\/transcript>/)?.[1]).toBe(escaped);
    expect(requestText(requests[4]!).match(/<nearby-transcript>\n([\s\S]*?)\n<\/nearby-transcript>/)?.[1]).toBe(escaped);
  });

  it("analyze keeps held and recovered lines after a bad reply and shares its measure with snap", async () => {
    const { program } = await import("../src/cli.js");
    const service = await import("../src/services/analyze.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const f = await fixture(3000);
    const windows = planTranscriptionWindows(3000, 600, 15);
    const firstPass = windows.map((window, index) => {
      if (index === 0) return { segments: [cue(0, 100, "first")] };
      if (index === 1) return { segments: [cue(165, 215, "second"), cue(255, 615, "third")] };
      return { segments: [cue(15, window.durationSeconds, "held")] };
    });
    const { analyzer, requests } = capture(...firstPass,
      { segments: [cue(5, 9, "addition")] }, { segments: [cue(5, 9, "another")] },
      { segments: [cue(5, 43, "invalid")] }, { matchNotes: "Synthetic", moments: [] });
    f.deps.decodeSpeechEnvelope.mockResolvedValue(soundTrack(3000, [100, 12], [700, 11], [800, 10]));
    const run = new AnalysisOrchestrator({ ...f.deps, createContextSource: vi.fn(), createAnalyzer: () => analyzer });
    vi.spyOn(service, "analyzeMeeting").mockImplementation((options, execution) => run.analyze(options, execution));
    await program.parseAsync(["analyze", "--json", "--source", "none", "--video", f.input, "--output", f.root,
      "--no-calibrate", "--no-screenshots", "--snap", "speech"], { from: "user" });
    const report = validateCliDocument("analyze", stdout.mock.calls.map(([chunk]) => chunk).join(""));
    expect(report.outcome).toBe("complete");
    expect(process.exitCode ?? 0).toBe(0);
    expect(report.warnings).toContain("recovered 1 line(s) at 105 to 109 s.");
    expect(report.warnings).toContain("recovered 1 line(s) at 705 to 709 s.");
    expect(report.warnings).toContain("800 to 840 s was not checked again (reply time outside clip); it holds 10 s of measured sound.");
    const manifest = JSON.parse(await readFile(join(report.runFolder, "manifest.json"), "utf8"));
    expect(manifest.derivedTranscript.rechecks.map((row: { status: string }) => row.status)).toEqual(["linesAdded", "failed"]);
    expect(manifest.derivedTranscript.belowCutoff).toEqual({ stretches: 0, seconds: 0 });
    expect(manifest.tokenUsage.transcript).toEqual({ promptTokens: 360, outputTokens: 36, totalTokens: 396 });
    const merged = formatDerivedTranscript([
      cue(0, 100, "first"), cue(105, 109, "addition"), cue(705, 709, "another"),
      cue(750, 800, "second"), cue(840, 1200, "third"), cue(1200, 1800, "held"),
      cue(1800, 2400, "held"), cue(2400, 3000, "held"),
    ]);
    expect(requestText(requests.at(-1)!)).toContain(merged);
    expect(manifest.derivedTranscript.sha256).toBe(createHash("sha256").update(merged).digest("hex"));
    expect(f.deps.decodeSpeechEnvelope).toHaveBeenCalledTimes(1);
    expect(f.deps.decodeSpeechEnvelope.mock.calls[0]![1]).not.toHaveProperty("slice");
    expect(analyzer.delete).toHaveBeenCalledTimes(8); // five first-pass uploads and three rechecks
  });

  it("keeps manifest rows for an empty first pass and omits rechecks for unknown duration", async () => {
    for (const duration of [100, undefined]) {
      const f = await fixture(100);
      f.deps.probeDurationSeconds.mockResolvedValue(duration);
      f.deps.decodeSpeechEnvelope.mockResolvedValue(soundTrack(100, [10, 12]));
      const held = duration === undefined ? [cue(0, 2, "held")] : [];
      const { analyzer, requests } = capture({ segments: held }, { matchNotes: "Synthetic", moments: [] });
      const run = new AnalysisOrchestrator({ ...f.deps, createContextSource: vi.fn(), createAnalyzer: () => analyzer });
      const options = await buildAnalyzeOptions(undefined, {
        source: "none", granolaTransport: "mcp", video: f.input, output: f.root, recipe: "requirements", depth: "standard",
        screenshots: false, calibrate: false, maxMoments: "all",
      }, "test-key");
      const result = await run.analyze(options);
      const derived = result.manifest.derivedTranscript;
      expect(requests).toHaveLength(2);
      expect(derived).toBeDefined();
      if (duration === undefined) {
        expect(f.deps.decodeSpeechEnvelope).not.toHaveBeenCalled();
        expect(derived).not.toHaveProperty("rechecks");
        expect(derived).not.toHaveProperty("belowCutoff");
      } else {
        expect(derived?.rechecks).toEqual([{ start: 0, end: 100, measuredSeconds: 12, addedLines: 0, status: "skipped" }]);
        expect(derived?.belowCutoff).toEqual({ stretches: 0, seconds: 0 });
      }
    }
  });

  it("attributes measured requests and detail repair to their passes in the analyze CLI receipt", async () => {
    const { program } = await import("../src/cli.js");
    const service = await import("../src/services/analyze.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const candidate = { start: "00:00:02", end: "00:00:04", kind: "test", summary: "Synthetic", importance: "low" };
    const detail = { accepted: true, kind: "test", title: "Synthetic", summary: "Synthetic" };
    for (const retention of ["provider", "run"]) {
      const f = await fixture(10);
      const { analyzer } = capture(
        { segments: [{ ...segment(), start: candidate.start, end: candidate.end }] },
        { matchNotes: "Synthetic", moments: [candidate, { ...candidate, start: "00:00:06", end: "00:00:08" }] },
        {}, detail, detail,
      );
      const run = new AnalysisOrchestrator({ ...f.deps, createContextSource: vi.fn(), createAnalyzer: () => analyzer });
      vi.spyOn(service, "analyzeMeeting").mockImplementation((options, execution) => run.analyze(options, execution));
      stdout.mockClear();
      stderr.mockClear();
      await program.parseAsync(["analyze", "--json", "--source", "none", "--video", f.input, "--output", f.root,
        "--no-calibrate", "--no-screenshots", "--concurrency", "2", ...(retention === "run" ? ["--retention", "run"] : [])], { from: "user" });
      const report = validateCliDocument("analyze", stdout.mock.calls.map(([chunk]) => chunk).join(""));
      const manifest = JSON.parse(await readFile(join(report.runFolder, "manifest.json"), "utf8"));
      expect(manifest.tokenUsage).toEqual({
        transcript: { promptTokens: 10, outputTokens: 1, totalTokens: 11 },
        index: { promptTokens: 20, outputTokens: 2, totalTokens: 22 },
        detail: { promptTokens: 120, outputTokens: 12, totalTokens: 132 },
      });
      expect(report.tokens).toEqual({ promptTokens: 150, outputTokens: 15, totalTokens: 165 });
      expect(report.tokens).toEqual(analyzer.usageSnapshot());
      expect(report.retention).toBe(retention);
      const line = `retention: ${retention}\n`;
      expect(stderr.mock.calls.filter(([chunk]) => chunk === line)).toHaveLength(1);
      const index = stderr.mock.calls.findIndex(([chunk]) => chunk === line);
      expect(stderr.mock.invocationCallOrder[index]).toBeLessThan(vi.mocked(analyzer.upload).mock.invocationCallOrder[0]!);
    }
  });

  it("omits a pass that returned no usage and preserves the measurements from other passes", async () => {
    const analyzer = new GeminiVideoAnalyzer("test-key", "gemini-test", {
      generateContent: vi.fn()
        .mockResolvedValueOnce({ text: '{"seconds":27}' })
        .mockResolvedValueOnce({ text: '{"segments":[]}', usageMetadata: { promptTokenCount: 8, totalTokenCount: 11 } }),
    });
    const file = { uri: "https://example.invalid/files/synthetic", mimeType: "video/mp4" };
    await analyzer.probeClipClock(file);
    expect(analyzer.measuredUsageByPass()).toBeUndefined();
    await analyzer.transcribe({ ...file, mimeType: "audio/aac" });
    expect(analyzer.measuredUsageByPass()).toEqual({ transcript: { promptTokens: 8, outputTokens: 3, totalTokens: 11 } });
  });

  it("captures the hosted provider request and preserves the derived transcript", async () => {
    const { analyzer, requests } = capture({ segments: merged });
    const provider = new GeminiHostedAnalysisProvider(analyzer);
    const segments = await provider.transcribe({
      name: "files/synthetic", uri: "https://example.invalid/files/synthetic", mimeType: "video/mp4",
    });
    expect(requests).toHaveLength(1);
    expectOriginalLanguage(requests[0]!);
    expect(resolveHostedTranscript({ derivedSegments: segments })).toEqual({
      origin: "gemini-audio", text: lines, alignmentOffsetSeconds: 0,
    });
  });
});

describe("output", () => {
  it("no segment text reaches stdout or stderr", async () => {
    for (const fail of [false, true]) {
      const f = await fixture(); if (fail) failAfterFirst(f); await cli(f);
      expect([...f.deps.stdout.mock.calls, ...f.deps.stderr.mock.calls].flat().join("\n")).not.toContain("ZEBRA-SENTINEL-LINE");
    }
  });
  it("reports retention before upload, measured totals and owned window starts", async () => {
    for (const [duration, retention, starts] of [[1500, "provider", [0, 600, 1200]], [10, "run", [0]]] as const) {
      const f = await fixture(duration);
      await cli(f, ["--json", ...(retention === "run" ? ["--retention", "run"] : [])]);
      const report = validateCliDocument("transcribe", f.deps.stdout.mock.calls[0]![0]);
      expect(report).toMatchObject({ retention, tokens: { promptTokens: 12, outputTokens: 3, totalTokens: 15 } });
      const line = `retention: ${retention}`;
      expect(f.deps.stderr.mock.calls.filter(([chunk]) => chunk === line)).toHaveLength(1);
      const index = f.deps.stderr.mock.calls.findIndex(([chunk]) => chunk === line);
      expect(f.deps.stderr.mock.invocationCallOrder[index]).toBeLessThan(f.analyzer.upload.mock.invocationCallOrder[0]!);
      const path = join(f.root, "synthetic.transcript.json");
      const { windowStarts, ...legacy } = JSON.parse(await readFile(path, "utf8"));
      expect(windowStarts).toEqual(starts);
      const reader = new FileContextSource(path);
      const current = await reader.meeting("synthetic");
      expect(current.transcript).toContain("[00:00:02] Speaker 1:");
      await writeFile(path, JSON.stringify(legacy));
      expect((await reader.meeting("synthetic")).transcript).toBe(current.transcript);
    }
  });

  it("reports blankCues and adjustedCues and writes JSON only when requested", async () => {
    const f = await fixture(10);
    const cue = { ...segment("a"), start: "00:00:04", end: "00:00:06" };
    f.analyzer.transcribe.mockResolvedValue([cue, { ...cue, text: "   " }, { ...cue, text: "b", end: "00:00:03" }]);
    await cli(f, ["--json", "--transcript-language", "fr-ca"]);
    expect(f.deps.stdout).toHaveBeenCalledTimes(1);
    const report = validateCliDocument("transcribe", f.deps.stdout.mock.calls[0]![0]);
    expect(report).toMatchObject({
      adjustedCues: 1, blankCues: 1, segmentCount: 3, model: "gemini-test", language: "fr-CA",
    });
    expect(report.paths.toSorted()).toEqual(["synthetic.srt", "synthetic.transcript.json", "synthetic_speakers.txt"]
      .map(name => join(f.root, name)));
    expect(JSON.parse(await readFile(join(f.root, "synthetic.transcript.json"), "utf8"))).toMatchObject({ clock: "source", adjustedCues: 1, blankCues: 1, segments: [{ start: 4 }, { start: 4 }, { start: 4 }] });
    expect(await readdir(f.root)).toEqual(["synthetic.mp4", "synthetic.srt", "synthetic.transcript.json", "synthetic_speakers.txt"]);
    const plain = await fixture(10); await cli(plain);
    expect(await readdir(plain.root)).toEqual(["synthetic.mp4", "synthetic.srt", "synthetic_speakers.txt"]);
  });
});

describe("transcript coverage", () => {
  it("merges the isolated reply on the source clock and keeps held cues exactly once", async () => {
    const f = await fixture(400);
    const held = [cue(0, 98, "A"), cue(98, 100, "B"), cue(100, 99, "point"), cue(140, 142, "right"), cue(142, 400, "last")];
    f.analyzer.transcribe.mockResolvedValue(held);
    await cli(f, ["--json"]);
    const read = (suffix: string) => readFile(join(f.root, "synthetic" + suffix), "utf8");
    const original = JSON.parse(await read(".transcript.json")).segments;
    const originalSrt = await read(".srt");
    f.deps.stderr.mockClear();
    f.deps.decodeSpeechEnvelope.mockClear().mockResolvedValue(soundTrack(400, [100, 12]));
    const line = cue(0, 4, "new"), repeated = cue(5, 9, "new");
    f.analyzer.transcribe.mockResolvedValueOnce(held).mockResolvedValueOnce([
      repeated, cue(0, 0, " b "), cue(0, 0, "POINT"), line, line, cue(35, 40, " RIGHT "), cue(39, 41, "crosses"), cue(40, 40, "outside"),
    ]);
    await cli(f, ["--json", "--force", "--transcript-language", "fr"]);
    const report = validateCliDocument("transcribe", f.deps.stdout.mock.lastCall![0]);
    const exported = JSON.parse(await read(".transcript.json"));
    expect(exported.segments.filter((row: { recovered?: true }) => row.recovered).map((row: { start: number }) => row.start)).toEqual([100, 105]);
    expect(exported.segments.filter((row: { recovered?: true }) => !row.recovered)).toEqual(original);
    const rechecks = [{
      start: 100, end: 140, measuredSeconds: 12, status: "linesAdded", addedLines: 2,
      addedSpans: [{ start: 100, end: 104 }, { start: 105, end: 109 }],
    }];
    for (const document of [exported, report]) expect(document).toMatchObject({ outcome: "complete", rechecks, belowCutoff: { stretches: 0, seconds: 0 } });
    expect(f.deps.stderr.mock.calls.flat().filter(line => /^(note|warning):/.test(line))).toEqual([
      "note: asking again for 1 stretch(es), 40 s of audio.", "note: recovered 2 line(s) at 100 to 109 s.",
    ]);
    expect(f.analyzer.transcribe.mock.lastCall).toEqual([expect.anything(), "fr", 40]);
    expect(f.deps.extractAudioTrack.mock.lastCall![2]).toMatchObject({ startSeconds: 100, durationSeconds: 40 });
    expect(originalSrt).toBe(renderSrt(held).text);
    expect(await read(".srt")).toBe(renderSrt([...held.slice(0, 3), cue(100, 104, "new"), cue(105, 109, "new"), ...held.slice(3)]).text);
    const speakers = await read("_speakers.txt");
    expect(speakers.match(/^#/gm)).toHaveLength(1);
    expect(speakers).not.toContain("recovered");
    expect(f.deps.decodeSpeechEnvelope.mock.calls.map(([, opts]) => opts?.slice)).toEqual([undefined]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("keeps held lines and earlier additions when a second reply exceeds its clip", async () => {
    const f = await fixture(400);
    const held = [cue(0, 100, "first"), cue(140, 200, "second"), cue(240, 400, "last")];
    f.analyzer.transcribe.mockResolvedValueOnce(held).mockResolvedValueOnce([cue(5, 9, "added")])
      .mockResolvedValueOnce([cue(0, 5, "discard whole reply"), cue(9, 43, "invalid")]);
    f.deps.decodeSpeechEnvelope.mockResolvedValue(soundTrack(400, [100, 12], [200, 10]));
    await cli(f, ["--json", "--retention", "run"]);
    const exported = JSON.parse(await readFile(join(f.root, "synthetic.transcript.json"), "utf8"));
    const report = validateCliDocument("transcribe", f.deps.stdout.mock.lastCall![0]);
    expect(exported.segments.map((row: { text: string }) => row.text)).toEqual(["first", "added", "second", "last"]);
    expect(report.outcome).toBe("unchecked");
    expect(report.rechecks[1]).toEqual({ start: 200, end: 240, measuredSeconds: 10, status: "failed", addedLines: 0 });
    expect(f.deps.stderr.mock.calls.flat()).toContain("warning: 200 to 240 s was not checked again (reply time outside clip); it holds 10 s of measured sound.");
    expect(await readFile(join(f.root, "synthetic_speakers.txt"), "utf8")).toContain("# Transcript unchecked: 200 to 240 s");
    expect(f.analyzer.delete).toHaveBeenCalledTimes(3);
    for (const [, path] of f.deps.extractAudioTrack.mock.calls) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reports eligibility at both thresholds and distinguishes an unavailable measurement", async () => {
    for (const [length, measured, below, asked] of [
      [19, 10, 0, false], [20, 9, 1, false], [20, 10, 0, true], [20, undefined, 0, false],
    ] as const) {
      const f = await fixture(100);
      f.analyzer.transcribe.mockResolvedValueOnce([cue(length, 100, "tail")]).mockResolvedValueOnce([]);
      if (measured === undefined) f.deps.decodeSpeechEnvelope.mockRejectedValue(new Error("decoder body"));
      else f.deps.decodeSpeechEnvelope.mockResolvedValue(soundTrack(100, [0, measured]));
      await cli(f, ["--json"]);
      const report = validateCliDocument("transcribe", f.deps.stdout.mock.lastCall![0]);
      const exported = JSON.parse(await readFile(join(f.root, "synthetic.transcript.json"), "utf8"));
      const speakers = await readFile(join(f.root, "synthetic_speakers.txt"), "utf8");
      const notices = f.deps.stderr.mock.calls.flat().filter(line => /^(note|warning):/.test(line));
      expect(f.analyzer.transcribe).toHaveBeenCalledTimes(asked ? 2 : 1);
      expect(process.exitCode ?? 0).toBe(0);
      if (measured === undefined) {
        for (const doc of [report, exported]) {
          expect(doc.outcome).toBe("unchecked");
          expect(doc).not.toHaveProperty("rechecks");
          expect(doc).not.toHaveProperty("belowCutoff");
        }
        expect(notices).toEqual(["warning: 0 to 100 s was not checked again (sound measurement unavailable)."]);
        expect(speakers).toContain("0 to 100 s was not checked again (sound measurement unavailable)");
      } else {
        const rechecks = asked ? [{ start: 0, end: length, measuredSeconds: measured, status: "noNewLines", addedLines: 0 }] : [];
        for (const doc of [report, exported]) {
          expect(doc).toMatchObject({ outcome: "complete", belowCutoff: { stretches: below, seconds: below * length }, rechecks });
        }
        expect(notices).toEqual(asked ? [
          "note: asking again for 1 stretch(es), 20 s of audio.", "note: 1 stretch(es) asked again with nothing found.",
        ] : []);
        expect(speakers.match(/^#/gm)).toHaveLength(1);
      }
    }
  });

  it("keeps additions across split pieces and names each failed or skipped piece", async () => {
    for (const failSecond of [false, true]) {
      const f = await fixture(4800);
      const windows = planTranscriptionWindows(4800, 600, 15);
      for (const w of windows) {
        const ownedEnd = w.startSeconds + w.durationSeconds;
        const held = w.startSeconds === 0 ? [cue(0, 100, "left")] : [];
        if (ownedEnd > 1350) held.push(cue(Math.max(1350, w.nominalStartSeconds) - w.startSeconds, w.durationSeconds, "held"));
        f.analyzer.transcribe.mockResolvedValueOnce(held);
      }
      f.analyzer.transcribe.mockResolvedValueOnce([cue(5, 9, "first addition"), cue(9, 11, "continued"), cue(599, 600, "edge")])
        .mockResolvedValueOnce(failSecond ? [cue(0, 603, "bad")] : [cue(0, 2, " EDGE "), cue(5, 9, "second addition")]);
      f.deps.decodeSpeechEnvelope.mockResolvedValue(soundTrack(4800, [100, 12], [700, 10], [1300, 5]));
      await cli(f, ["--json"]);
      const report = validateCliDocument("transcribe", f.deps.stdout.mock.lastCall![0]);
      expect(report.outcome).toBe("unchecked");
      expect(report.rechecks).toEqual([{
        start: 100, end: 1350, measuredSeconds: 27, status: failSecond ? "failed" : "skipped",
        addedLines: failSecond ? 3 : 4, addedSpans: [
          { start: 105, end: 111 }, { start: 699, end: 700 }, ...(failSecond ? [] : [{ start: 705, end: 709 }]),
        ],
      }]);
      const notices = f.deps.stderr.mock.calls.flat();
      expect(notices).toContain("note: asking again for 2 stretch(es), 1200 s of audio.");
      expect(notices.filter(line => line.startsWith("warning:"))).toEqual([
        ...(failSecond ? ["warning: 700 to 1300 s was not checked again (reply time outside clip); it holds 10 s of measured sound."] : []),
        "warning: 1300 to 1350 s was not checked again (budget limit); it holds 5 s of measured sound.",
      ]);
      expect(await readFile(join(f.root, "synthetic_speakers.txt"), "utf8"))
        .toContain("# Transcript unchecked: " + (failSecond ? "700 to 1300 s, " : "") + "1300 to 1350 s");
      expect(f.analyzer.transcribe).toHaveBeenCalledTimes(windows.length + 2);
      const extracted = f.deps.extractAudioTrack.mock.calls.slice(windows.length).map(([, , options]) => [options?.startSeconds, options?.durationSeconds]);
      expect(extracted).toEqual([[100, 600], [700, 600]]);
    }
  });

  it("budgets requests by measured sound then start, and continues with pieces that fit", async () => {
    for (const [duration, starts, statuses] of [
      [400, [150, 0, 30], ["noNewLines", "noNewLines", "skipped", "noNewLines"]],
      [480, [150, 60], ["skipped", "skipped", "noNewLines", "noNewLines"]],
      [600, [150, 60, 0], ["noNewLines", "skipped", "noNewLines", "noNewLines"]],
    ] as const) {
      const f = await fixture(duration);
      const held = [cue(20, 30, "a"), cue(50, 60, "b"), cue(140, 150, "c"), cue(180, duration, "d")];
      f.analyzer.transcribe.mockResolvedValueOnce(held).mockResolvedValue([]);
      f.deps.decodeSpeechEnvelope.mockResolvedValue(soundTrack(duration, [0, 10], [30, 10], [60, 11], [150, 12]));
      await cli(f, ["--json"]);
      const report = validateCliDocument("transcribe", f.deps.stdout.mock.lastCall![0]);
      const attempted = f.deps.extractAudioTrack.mock.calls.slice(1).map(([, , options]) => options?.startSeconds);
      expect(attempted).toEqual(starts);
      expect(report.rechecks.map((row: { status: string }) => row.status)).toEqual(statuses);
    }
  });

  it("warns once for a window dropping over 600 characters in its lead-in", async () => {
    for (const characters of [15, 16]) {
      const f = await fixture(900);
      const dropped = Array.from({ length: 40 }, () => ({
        ...segment("x".repeat(characters)), start: "00:00:01", end: "00:00:20",
      }));
      f.analyzer.transcribe.mockResolvedValueOnce([segment()]).mockResolvedValueOnce([...dropped, segment()]);
      await cli(f, ["--json"]);
      expect(f.deps.stderr.mock.calls.flat().filter(line => line.includes("lead-in"))).toEqual(
        characters === 15 ? [] : ["warning: window 2 dropped 40 transcript lines in its lead-in."]);
    }
  });

});

describe("validation", () => {
  it("a failed --json call prints the error line on stderr and the error document on stdout", async () => {
    const f = await fixture();
    await cli(f, ["--transcript-language", "en_US", "--json"]);
    expect(f.deps.stderr).toHaveBeenCalledWith(expect.stringMatching(/^error: .*--transcript-language/));
    const document = JSON.parse(f.deps.stdout.mock.calls.flat().join(""));
    expect(document.error.code).toBe("USAGE");
    process.exitCode = 0;
  });
  it("refuses an invalid language hint before extraction, upload or generation", async () => {
    const f = await fixture();
    await cli(f, ["--transcript-language", "en_US"]);
    expect(f.deps.stderr).toHaveBeenCalledWith(expect.stringContaining("--transcript-language"));
    expect(process.exitCode).toBe(1);
    expect(f.deps.extractAudioTrack).not.toHaveBeenCalled();
    expect(f.analyzer.upload).not.toHaveBeenCalled();
    expect(f.analyzer.transcribe).not.toHaveBeenCalled();
  });
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

describe("reviewer supplementary probes", () => {
  it("new output directories and audio staging are private", async () => {
    const f = await fixture(10);
    const output = join(f.root, "exports", "nested");
    const stagingModes: number[] = [];
    f.deps.extractAudioTrack.mockImplementation(async (_input, path) => {
      stagingModes.push((await stat(dirname(path))).mode & 0o777);
      await writeFile(path, "synthetic audio"); return true;
    });
    await cli(f, ["--output", output]);
    expect(process.exitCode ?? 0).toBe(0);
    if (process.platform !== "win32") {
      expect(stagingModes).toEqual([0o700]);
      expect((await stat(dirname(output))).mode & 0o777).toBe(0o700);
      expect((await stat(output)).mode & 0o777).toBe(0o700);
    }
  });
  it("Y02 provider-body sentinel never reaches terminal or exported files", async () => {
    for (const fail of [false, "refusal", "offline"]) {
      const f = await fixture(10);
      const providerBody = "PROVIDER-BODY-SENTINEL";
      const error = fail === "offline" ? new TypeError(providerBody, {cause: Object.assign(new Error(), {code: "ENOTFOUND"})}) : new ApiError({ message: providerBody, status: fail ? 403 : 503 });
      if (fail) f.analyzer.transcribe.mockRejectedValue(error);
      else f.analyzer.transcribe.mockRejectedValueOnce(error);
      await cli(f, ["--json"]);
      const terminal = [...f.deps.stdout.mock.calls, ...f.deps.stderr.mock.calls].flat().join("\n");
      expect(terminal).not.toContain(providerBody);
      expect(terminal).not.toContain("ZEBRA-SENTINEL-LINE");
      expect(terminal).not.toContain("test-key");
      expect(f.analyzer.transcribe).toHaveBeenCalledTimes(2);
      if (fail) {
        expect(process.exitCode).toBe(fail === "offline" ? 20 : 1);
        expect(JSON.parse(f.deps.stdout.mock.lastCall![0])).toMatchObject({ error: {code: fail === "offline" ? "PROVIDER_UNREACHABLE" : "PROVIDER_REFUSED"} });
        await expectNoOutputs(f);
      } else {
        for (const suffix of [".srt", "_speakers.txt", ".transcript.json"]) {
          const exported = await readFile(join(f.root, `synthetic${suffix}`), "utf8");
          expect(exported).toContain("ZEBRA-SENTINEL-LINE");
          expect(exported).not.toContain(providerBody);
          expect(exported).not.toContain("test-key");
          expect(exported).not.toContain(f.input);
        }
      }
    }
  });
  it("Y03 run retention deletes uploads on SIGINT and leaves input unchanged", async () => {
    const f = await fixture();
    f.analyzer.transcribe.mockResolvedValueOnce([segment()]).mockImplementationOnce(async () => {
      process.emit("SIGINT"); return [segment()];
    });
    await cli(f, ["--retention", "run"]);
    expect(process.exitCode).toBe(130);
    expect(f.analyzer.upload).toHaveBeenCalledTimes(2);
    expect(f.analyzer.delete.mock.calls.map(([file]) => file)).toEqual(await Promise.all(f.analyzer.upload.mock.results.map(result => result.value)));
    expect(await readFile(f.input, "utf8")).toBe("synthetic media");
    await expectNoOutputs(f);
  });
});
