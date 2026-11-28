import type { RangeClock } from "../domain/range-clock.js";
import { boundIndex, modelBound, modelSpan, type Bound } from "../domain/source-bound.js";
import { stat, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import type { IndexedMoment } from "../domain/types.js";
import { secondsToTimestamp, timestampToSeconds } from "../lib/time.js";
import type { extractScreenshot } from "./screenshots.js";

export interface DetailStillFile {
  seconds: number;
  path: string;
  exactTime?: Bound;
}

export const unavailableStillWarning = "Full-size frame unavailable. Treat any quoted screen text as unverified.";
export const unreadScreenTextWarning = "Screen text was not read from a still.";

export async function extractDetailStills(
  video: string, candidate: IndexedMoment, duration: number | undefined,
  scratch: string, ordinal: number, extract: typeof extractScreenshot, checkCanceled: () => void, clock?: RangeClock,
): Promise<DetailStillFile[]> {
  const start = timestampToSeconds(candidate.start);
  const end = timestampToSeconds(candidate.end);
  const span = clock && modelSpan(clock,start,end);
  const midpoint = Math.floor((start + end) / 2);
  const priority = end - start < 10 ? [midpoint] : [midpoint, start + 2, end - 2];
  const selected: DetailStillFile[] = [];
  let remaining = 15_000_000;
  for (const seconds of priority) {
    checkCanceled();
    if (duration !== undefined && seconds >= duration) continue;
    let path = join(scratch, `still-${ordinal}-${seconds}.png`);
    let exactTime: Bound | undefined;
    const position = clock && span ? {clock,span,target:modelBound(clock,seconds,0n,clock.cutLength),captured:(b: Bound) => {exactTime=b;}} : undefined;
    if (await extract(video, secondsToTimestamp(seconds), path, undefined, position) && (!position || exactTime)) {
      if (exactTime) {
        const final = join(scratch,`still-${ordinal}-${boundIndex(exactTime)}.png`);
        if (final !== path) await rename(path, final);
        path = final;
      }
      const size = (await stat(path)).size;
      const encodedBytes = 4 * Math.ceil(size / 3);
      if (size > 0 && encodedBytes <= remaining) {
        remaining -= encodedBytes;
        selected.push({ seconds, path, ...(exactTime && {exactTime}) });
        continue;
      }
    }
    await rm(path, { force: true });
  }
  return selected.sort((a, b) => a.seconds - b.seconds);
}
