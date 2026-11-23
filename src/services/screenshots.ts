import { childEnvironment, spawn } from "../lib/child-env.js";
import { access, chmod, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { timestampToSeconds } from "../lib/time.js";

/** Candidate range the settled-frame search must stay inside. */
export interface ScreenshotWindow {
  start: string;
  end: string;
}

// Settled-frame search, used only when the caller passes a window (today only
// the teaching-points recipe): sample within 1 second of the cited time, score
// each frame by how much the picture changes into and out of it, and prefer
// the steadiest frame nearest the cited time. A frame caught mid-transition
// scores high and loses to a settled neighbour. Changes above the cut
// threshold stop the search, but a low-contrast cut (two shots of similar
// brightness) stays under it and can be crossed. No model call.
const SEARCH_RADIUS_SECONDS = 1;
const SAMPLE_FPS = 5;
const THUMB_WIDTH = 64;
const THUMB_HEIGHT = 36;
const THUMB_BYTES = THUMB_WIDTH * THUMB_HEIGHT;
const MAX_SAMPLE_BYTES = THUMB_BYTES * 64;

export async function extractScreenshot(
  video: string,
  timestamp: string,
  destination: string,
  window?: ScreenshotWindow,
): Promise<boolean> {
  const seconds = Math.max(0, timestampToSeconds(timestamp));
  if (window && await extractSettledScreenshot(video, seconds, window, destination)) {
    return true;
  }
  return extractSingleFrame(video, seconds, destination);
}

async function extractSingleFrame(video: string, seconds: number, destination: string): Promise<boolean> {
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(seconds), "-i", video,
      "-frames:v", "1", "-q:v", "2", destination,
    ], { env: childEnvironment("media"), stdio: "ignore" });
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  if (code !== 0) return false;
  return finalize(destination);
}

async function finalize(destination: string): Promise<boolean> {
  try {
    await access(destination);
    await chmod(destination, 0o600);
    return true;
  } catch {
    await rm(destination, { force: true });
    return false;
  }
}

/** Search bounds: the cited time ± the radius, clipped to the candidate range. */
export function settledSearchBounds(
  seconds: number,
  window: ScreenshotWindow,
): { start: number; end: number } | undefined {
  const start = Math.max(0, timestampToSeconds(window.start), seconds - SEARCH_RADIUS_SECONDS);
  const end = Math.min(timestampToSeconds(window.end), seconds + SEARCH_RADIUS_SECONDS);
  // Fewer than three samples leave nothing worth choosing between.
  return end - start >= 3 / SAMPLE_FPS ? { start, end } : undefined;
}

// A change this large between two samples 0.2 s apart is treated as a cut. On
// the eight explainer videos of 2026-11-22, cuts measured 34 to 67 grey levels
// and the largest step inside a crossfade measured 27. A cut between shots of
// similar brightness measures less and is not detected.
const HARD_CUT_CHANGE = 30;

/**
 * Index of the steadiest frame nearest `targetIndex`, or undefined when there
 * is nothing to compare. A frame's score is the mean absolute change from the
 * previous frame plus the change to the next; a frame with one neighbour
 * counts its one change twice. The search stops at a change above the cut
 * threshold (a low-contrast cut stays under it), and the cited frame is kept
 * whenever it is already about as steady as the steadiest frame.
 */
export function pickSettledFrame(
  frames: readonly Uint8Array[],
  targetIndex: number,
): number | undefined {
  if (frames.length < 2) return undefined;
  const change: number[] = [];
  for (let index = 0; index + 1 < frames.length; index += 1) {
    const a = frames[index]!;
    const b = frames[index + 1]!;
    if (a.length !== b.length || a.length === 0) return undefined;
    let total = 0;
    for (let pixel = 0; pixel < a.length; pixel += 1) total += Math.abs(a[pixel]! - b[pixel]!);
    change.push(total / a.length);
  }
  const target = Math.min(frames.length - 1, Math.max(0, targetIndex));
  let first = target;
  while (first > 0 && change[first - 1]! <= HARD_CUT_CHANGE) first -= 1;
  let last = target;
  while (last < frames.length - 1 && change[last]! <= HARD_CUT_CHANGE) last += 1;
  if (first === last) return target;
  const score = (index: number): number => {
    const before = index > first ? change[index - 1]! : undefined;
    const after = index < last ? change[index]! : undefined;
    return before !== undefined && after !== undefined
      ? before + after
      : 2 * (before ?? after!);
  };
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = first; index <= last; index += 1) minimum = Math.min(minimum, score(index));
  // Compression noise on a still picture is a few hundredths of a grey level;
  // the relative term keeps "near the minimum" meaningful for moving footage.
  const tolerance = 0.05 + minimum * 0.25;
  let best = target;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = first; index <= last; index += 1) {
    if (score(index) > minimum + tolerance) continue;
    const distance = Math.abs(index - target);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

async function extractSettledScreenshot(
  video: string,
  seconds: number,
  window: ScreenshotWindow,
  destination: string,
): Promise<boolean> {
  const bounds = settledSearchBounds(seconds, window);
  if (!bounds) return false;
  let scratch: string;
  try {
    scratch = await mkdtemp(join(dirname(destination), ".settled-"));
  } catch {
    return false;
  }
  try {
    // One decode feeds both outputs, so thumbnail k and frame-k.png are the
    // same picture and the chosen file is kept as decoded, never re-seeked.
    const thumbnails = await new Promise<Buffer | undefined>((resolve) => {
      const child = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        // -ss and -t are input options here so both outputs see the window.
        "-ss", String(bounds.start), "-t", String(bounds.end - bounds.start), "-i", video,
        "-filter_complex",
        `[0:v]fps=${SAMPLE_FPS},split=2[full][small];[small]scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:flags=area,format=gray[thumb]`,
        "-map", "[full]", join(scratch, "frame-%03d.png"),
        "-map", "[thumb]", "-f", "rawvideo", "pipe:1",
      ], { env: childEnvironment("media"), stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_SAMPLE_BYTES) child.kill();
        else chunks.push(chunk);
      });
      child.once("error", () => resolve(undefined));
      child.once("close", (code) => resolve(code === 0 && size <= MAX_SAMPLE_BYTES ? Buffer.concat(chunks) : undefined));
    });
    if (!thumbnails || thumbnails.length % THUMB_BYTES !== 0) return false;
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset < thumbnails.length; offset += THUMB_BYTES) {
      frames.push(thumbnails.subarray(offset, offset + THUMB_BYTES));
    }
    const files = (await readdir(scratch)).filter((name) => /^frame-\d{3}\.png$/.test(name)).sort();
    if (files.length !== frames.length) return false;
    const target = Math.min(frames.length - 1, Math.max(0, Math.round((seconds - bounds.start) * SAMPLE_FPS)));
    const chosen = pickSettledFrame(frames, target);
    // Unmoved: keep the exact single-frame grab at the cited time. The sampled
    // frame nearest that time can sit one frame across a cut from it.
    if (chosen === undefined || chosen === target) return false;
    await rename(join(scratch, files[chosen]!), destination);
    return finalize(destination);
  } catch {
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
