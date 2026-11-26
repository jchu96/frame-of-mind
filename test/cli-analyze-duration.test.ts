import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
