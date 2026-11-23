import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractScreenshot,
  pickSettledFrame,
  settledSearchBounds,
} from "../src/services/screenshots.js";

const frame = (value: number) => new Uint8Array(16).fill(value);

describe("settled-frame selection", () => {
  it("skips frames caught mid-transition for the nearest settled one", () => {
    // 0..2 still, 3..5 fading, 6..9 still on a new picture.
    const frames = [10, 10, 10, 18, 26, 34, 42, 42, 42, 42].map(frame);
    expect(pickSettledFrame(frames, 4)).toBe(1);
    expect(pickSettledFrame(frames, 5)).toBe(7);
  });

  it("keeps the cited frame when the picture is already still", () => {
    expect(pickSettledFrame([5, 5, 5, 5, 5].map(frame), 2)).toBe(2);
    expect(pickSettledFrame([5, 5, 5, 5, 5].map(frame), 0)).toBe(0);
  });

  it("keeps a cited frame on an animated diagram rather than crossing a cut to a still shot", () => {
    // Animated diagram (steady small changes), a hard cut, then a still shot.
    const frames = [10, 14, 18, 22, 120, 120, 120, 120].map(frame);
    expect(pickSettledFrame(frames, 0)).toBe(0);
    expect(pickSettledFrame(frames, 2)).toBe(2);
    expect(pickSettledFrame(frames, 5)).toBe(5);
  });

  it("treats a change across a cut as a shot boundary, not as motion", () => {
    // The cited frame is the last one before a cut; its own shot is still.
    const frames = [30, 30, 30, 200, 205, 210].map(frame);
    expect(pickSettledFrame(frames, 2)).toBe(2);
  });

  it("treats compression noise on a still picture as still", () => {
    // Thumbnail-sized frames where a handful of pixels flicker by one level.
    const noisy = (seed: number) => {
      const pixels = new Uint8Array(64 * 36).fill(50);
      for (let index = seed; index < pixels.length; index += 300) pixels[index] = 51;
      return pixels;
    };
    expect(pickSettledFrame([0, 1, 2, 3, 4, 5].map(noisy), 2)).toBe(2);
  });

  it("needs frames of one size to compare", () => {
    expect(pickSettledFrame([frame(1)], 0)).toBeUndefined();
    expect(pickSettledFrame([frame(1), new Uint8Array(4), frame(1)], 1)).toBeUndefined();
  });

  it("never searches outside the candidate range", () => {
    expect(settledSearchBounds(12, { start: "00:00:10", end: "00:00:20" })).toEqual({ start: 11, end: 13 });
    expect(settledSearchBounds(10, { start: "00:00:10", end: "00:00:20" })).toEqual({ start: 10, end: 11 });
    expect(settledSearchBounds(20, { start: "00:00:10", end: "00:00:20" })).toEqual({ start: 19, end: 20 });
    expect(settledSearchBounds(0, { start: "00:00:00", end: "00:00:00" })).toBeUndefined();
  });
});

describe("settled screenshot with real ffmpeg", () => {
  let root: string;
  let video: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "settled-screenshot-"));
    video = join(root, "fade.mp4");
    // Red until 1.5 s, a one-second crossfade, then blue: 2.0 s is mid-fade.
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=160x90:r=25:d=3",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=3",
      "-filter_complex", "[0][1]xfade=transition=fade:duration=1:offset=1.5,format=yuv420p",
      video,
    ]);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function averageColour(path: string): number[] {
    return [...execFileSync("ffmpeg", [
      "-v", "error", "-i", path, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ])];
  }
  const isPure = ([red, , blue]: number[]) => (red! > 200 && blue! < 60) || (blue! > 200 && red! < 60);

  it("a single-frame grab at the cited mid-fade time catches the blend", async () => {
    const destination = join(root, "single.png");
    expect(await extractScreenshot(video, "00:00:02", destination)).toBe(true);
    expect(isPure(averageColour(destination))).toBe(false);
  });

  it("the settled search leaves the fade for a still picture inside the candidate", async () => {
    const destination = join(root, "settled.png");
    expect(await extractScreenshot(video, "00:00:02", destination, { start: "00:00:01", end: "00:00:04" })).toBe(true);
    expect(isPure(averageColour(destination))).toBe(true);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.startsWith(".settled-"))).toEqual([]);
  });
});
