import type { IndexedMoment } from "./types.js";
import { timestampToSeconds } from "../lib/time.js";

const importance = { high: 0, medium: 1, low: 2 } as const;
const byTime = (a: IndexedMoment, b: IndexedMoment) =>
  timestampToSeconds(a.start) - timestampToSeconds(b.start);

/** Select by importance, then restore recording order without changing times. */
export function selectCandidates(moments: readonly IndexedMoment[], count: number): IndexedMoment[] {
  return [...moments]
    .sort((a, b) => importance[a.importance] - importance[b.importance] || byTime(a, b))
    .slice(0, count)
    .sort(byTime);
}
