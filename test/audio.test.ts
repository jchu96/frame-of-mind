import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { extractAudioTrack } from "../src/services/audio.js";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

describe("extractAudioTrack", () => {
  it("returns false without throwing for an invalid recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "frame-of-mind-audio-test-"));
    temporaryDirectories.push(root);
    const video = join(root, "not-a-video.mp4");
    await writeFile(video, "synthetic-not-a-video");
    const destination = join(root, "derived-audio.aac");

    await expect(extractAudioTrack(video, destination)).resolves.toBe(false);
    await expect(stat(destination)).rejects.toThrow();
  });

  it("extracts a private audio derivative from a real recording when ffmpeg exists", async (context) => {
    if (!(await ffmpegAvailable())) return context.skip();
    const root = await mkdtemp(join(tmpdir(), "frame-of-mind-audio-test-"));
    temporaryDirectories.push(root);
    const video = join(root, "synthetic.mp4");
    const generated = await new Promise<number | null>((resolve) => {
      const child = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-shortest", video,
      ], { stdio: "ignore" });
      child.once("error", () => resolve(null));
      child.once("close", resolve);
    });
    if (generated !== 0) return context.skip();
    const destination = join(root, "derived-audio.aac");

    await expect(extractAudioTrack(video, destination)).resolves.toBe(true);
    const stats = await stat(destination);
    expect(stats.size).toBeGreaterThan(0);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
