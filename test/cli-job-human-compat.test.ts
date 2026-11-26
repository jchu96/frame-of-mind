import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { runCli } from "../src/cli-contract.js";
import { registerTranscribe } from "../src/commands/transcribe.js";
import * as analyze from "../src/services/analyze.js";

// Fix the release stamp along with the clock and run ID so a future package
// version bump does not change the base fixture's rendered bytes.
vi.mock("../src/version.js", async importOriginal => ({...await importOriginal<typeof import("../src/version.js")>(), VERSION: "0.6.0-beta.4"}));
vi.mock("../src/services/media-capabilities.js", () => ({requireMedia: async () => {}}));

it("human analyze and transcribe preserve the base bytes, output streams, exits, retries and retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "human-compat-"));
  const video = join(root, "fixture.mp4");
  const now = () => "2026-11-24T00:00:00.000Z";
  const model = "gemini-test";
  const wire: string[] = [];
  const streams: string[][] = [[], []];
  const exits = [];
  const analyzer = {
    model,
    async upload(_file: string, mime: string) {
      wire.push("upload " + mime);
      return {name: "files/fixture", mimeType: mime, uri: "https://example.invalid/fixture"};
    },
    async index() { wire.push("index"); return {matchNotes: "fixture", moments: []}; },
    async interrogate() { throw new Error("No fixture candidates."); },
    async transcribe() {
      if (!wire.includes("retry")) { wire.push("retry"); throw new Error("fixture failure"); }
      wire.push("transcribed");
      return [{start: "00:00:00", end: "00:00:01", speaker: "Speaker 1", text: "fixture"}];
    },
    async delete() { wire.push("deleted"); },
  };
  try {
    await writeFile(video, "fixture");
    vi.stubEnv("GEMINI_API_KEY", "stand-in");
    vi.stubEnv("FRAME_OF_MIND_UPLOAD_RETENTION", undefined);
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("GEMINI_MODEL", model);
    const {program} = await import("../src/cli-main.js");
    const shared = {createAnalyzer: () => analyzer, now, probeDurationSeconds: async () => 1, sleep: async () => {}};
    const service = new analyze.AnalysisOrchestrator({...shared, createContextSource() {throw new Error("Unexpected context.");}, createRunId: () => "fixture-run"});
    vi.spyOn(analyze, "analyzeMeeting").mockImplementation((options, execution) => service.analyze(options, execution));
    for (const [index, stream] of [process.stdout, process.stderr].entries()) {
      vi.spyOn(stream, "write").mockImplementation(chunk => { streams[index]!.push(String(chunk)); return true; });
    }
    process.exitCode = 0;
    await runCli(program, ["analyze", "--source", "none", "--video", video, "--output", join(root, "analysis"),
      "--model", model, "--no-calibrate", "--no-derived-transcript", "--no-screenshots"]);
    exits.push(process.exitCode);
    const transcription = new Command();
    registerTranscribe(transcription, {...shared,
      decodeSpeechEnvelope: async () => ({ startMs: 0, length: 100, blocks: [new Float32Array(100).fill(-96)] }),
      extractAudioTrack: async (_input, path) => { await writeFile(path, "aac"); return true; }});
    await runCli(transcription, ["transcribe", video, "--retention", "run"]);
    exits.push(process.exitCode);
    const files: Record<string, string> = {};
    for (const file of (await readdir(root, {recursive: true, withFileTypes: true})).filter(x => x.isFile())) {
      const path = join(file.parentPath, file.name);
      if (path !== video) files[relative(root, path).split(sep).join("/")] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    // The two new stderr receipts are additive to the original stream oracle.
    expect(streams[1]!.filter(line => line.startsWith("retention:"))).toEqual(["retention: provider\n", "retention: run\n"]);
    streams[1] = streams[1]!.filter(line => !line.startsWith("retention:"));
    // The fixture's sound track is silent, so its transcript line is noted as quiet.
    const quiet = (line: string) => / line\(s\) sit where no sound was measured\.\n$/.test(line);
    expect(streams[1]!.filter(quiet)).toEqual(["note: 1 line(s) sit where no sound was measured.\n"]);
    streams[1] = streams[1]!.filter(line => !quiet(line));
    // File bytes are hashed verbatim. Only the platform-specific temporary
    // directory in displayed paths is substituted for the base oracle.
    const evidence = {files: Object.fromEntries(Object.entries(files).sort()), wire, exits,
      streams: streams.map(chunks => chunks.join("").replaceAll(root, "<fixture>").split(sep).join("/"))};
    const digest = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
    expect(exits).toEqual([0, 0]);
    expect(wire).toEqual(["upload video/mp4", "index", "upload audio/aac", "retry", "deleted", "upload audio/aac", "transcribed", "deleted"]);
    expect(digest).toBe("a560be6705d27f1a3c3cb42657a96b332f3d301d711c766e8ba1da115897af43");
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
    await rm(root, {recursive: true, force: true});
  }
});
