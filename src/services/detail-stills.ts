import { stat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IndexedMoment } from "../domain/types.js";
import { secondsToTimestamp, timestampToSeconds } from "../lib/time.js";
import type { extractScreenshot } from "./screenshots.js";

export interface DetailStillFile {
  seconds: number;
  path: string;
}

export const unavailableStillWarning = "Full-size frame unavailable. Treat any quoted screen text as unverified.";

export async function extractDetailStills(
  video: string, candidate: IndexedMoment, duration: number | undefined,
  scratch: string, ordinal: number, extract: typeof extractScreenshot, checkCanceled: () => void,
): Promise<DetailStillFile[]> {
  const start = timestampToSeconds(candidate.start);
  const end = timestampToSeconds(candidate.end);
  const midpoint = Math.floor((start + end) / 2);
  const priority = end - start < 10 ? [midpoint] : [midpoint, start + 2, end - 2];
  const selected: DetailStillFile[] = [];
  let remaining = 15_000_000;
  for (const seconds of priority) {
    checkCanceled();
    if (duration !== undefined && seconds >= duration) continue;
    const path = join(scratch, `still-${ordinal}-${seconds}.png`);
    if (await extract(video, secondsToTimestamp(seconds), path)) {
      const size = (await stat(path)).size;
      const encodedBytes = 4 * Math.ceil(size / 3);
      if (size > 0 && encodedBytes <= remaining) {
        remaining -= encodedBytes;
        selected.push({ seconds, path });
        continue;
      }
    }
    await rm(path, { force: true });
  }
  return selected.sort((a, b) => a.seconds - b.seconds);
}
