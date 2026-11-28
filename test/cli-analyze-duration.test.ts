import { fixtureSource } from "./helpers/source-clock.js";
import { ContractError } from "../src/domain/contract-error.js";
import { RangeClock } from "../src/domain/range-clock.js";
import * as source from "../src/services/source-recording.js";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCli } from "../src/cli-contract.js";
import { program } from "../src/cli-main.js";
import { GeminiVideoAnalyzer } from "../src/adapters/gemini.js";
import * as audio from "../src/services/audio.js";

vi.mock("../src/adapters/gemini.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/adapters/gemini.js")>(),
  GeminiVideoAnalyzer: vi.fn(),
}));

it("analyze reports the exact duration refusal to humans and JSON callers before provider work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "duration-refusal-"));
  const video = join(directory, "fixture.mp4");
  const previousExit = process.exitCode;
  try {
    await writeFile(video, "synthetic-video");
    vi.stubEnv("GEMINI_API_KEY", "stand-in");
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("FRAME_OF_MIND_MAX_VIDEO_SECONDS", "7200");
    vi.spyOn(source, "withSourceRecording").mockImplementation(fixtureSource(() => 7200.6));
    const probe = vi.spyOn(audio, "probeDurationSeconds").mockResolvedValue(7200.6);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const args = ["analyze", "--source", "none", "--video", video, "--output", directory];

    process.exitCode = 0;
    await runCli(program, args);
    expect(process.exitCode).not.toBe(0);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([chunk]) => chunk).join("")).toContain(
      "Recording is 7200.6 seconds long and the limit is 7200 seconds. Split the recording into shorter parts.",
    );

    process.exitCode = 0;
    await runCli(program, [...args, "--json"]);
    expect(JSON.parse(stdout.mock.calls.map(([chunk]) => chunk).join(""))).toEqual({
      schemaVersion: 1,
      error: {
        code: "RECORDING_TOO_LONG",
        message: "recording too long.",
        details: { durationSeconds: 7200.6, limitSeconds: 7200 },
      },
    });
    expect(process.exitCode).toBe(4);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(GeminiVideoAnalyzer).not.toHaveBeenCalled();
  } finally {
    process.exitCode = previousExit;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("returns resolved coverage in the reply when a local cut fails before upload", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepare-receipt-"));
  const previousExit = process.exitCode;
  try {
    const video = join(root, "input.mp4");
    await writeFile(video, "fixture");
    vi.stubEnv("GEMINI_API_KEY", "stand-in");
    vi.stubEnv("SENTRY_DSN", "");
    vi.spyOn(source, "withSourceRecording").mockImplementation(async (_file, options, _needs, tell) => {
      const clock = RangeClock.resolve({unit:"frames", rate:{num:25, den:1}, length:100n}, options);
      tell(clock.rangeLine());
      options.onSourceResolved?.(clock);
      throw new ContractError("DECODE_FAILED", "Local encode failed.");
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCli(program, ["analyze","--source","none","--video",video,"--from","25f","--to","51f","--output",join(root,"out"),"--json"]);
    const failure = JSON.parse(stdout.mock.calls.map(([s]) => s).join(""));
    const line = stderr.mock.calls.map(([s]) => String(s)).find(s => s.startsWith("Source coverage: "))!;
    const receipt = JSON.parse(line.slice("Source coverage: ".length));
    expect(receipt).toMatchObject({sourceRange:{fromFrame:"25",toFrameExclusive:"51"},sourceLengthFrames:"100",coverage:{full:false,covered:[]},uploads:[]});
    expect(failure.error).toMatchObject({code:"DECODE_FAILED",details:{...receipt,phase:"prepare",sent:false}});
    expect(await readdir(root)).toEqual(["input.mp4"]);
    expect(GeminiVideoAnalyzer).not.toHaveBeenCalled();
  } finally {
    process.exitCode = previousExit;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, {recursive:true,force:true});
  }
});
