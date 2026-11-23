import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { extractScreenshot } from "../src/services/screenshots.js";
import { probeDurationSeconds } from "../src/services/audio.js";

let root: string, video: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "child-env-real-"));
  video = join(root, "synthetic.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=s=160x90:r=25:d=2", video]);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
it("real ffmpeg extracts a private screenshot with the allowed environment", async () => {
  const destination = join(root, "frame.jpg");
  expect(await extractScreenshot(video, "00:00:01", destination)).toBe(true);
  const file = await stat(destination);
  expect(file.size).toBeGreaterThan(0); expect(file.mode & 0o777).toBe(0o600);
});
it("real ffprobe reads duration with the allowed environment", async () => {
  expect(await probeDurationSeconds(video)).toBeCloseTo(2);
});
