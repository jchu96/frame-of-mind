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
import { planTranscriptionWindows } from "../src/services/audio.js";
import { formatDerivedTranscript } from "../src/services/transcript.js";
import { renderSrt } from "../src/services/transcript-render.js";
import { timestampToSeconds } from "../src/lib/time.js";
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
        return { text: JSON.stringify(responses[requests.length - 1]) };
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
