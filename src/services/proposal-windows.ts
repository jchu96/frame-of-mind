import type { Candidate } from "../domain/candidates.js";
import type { RangeClock } from "../domain/range-clock.js";
import type { IndexedMoment } from "../domain/types.js";
import { secondsToTimestamp, timestampToSeconds } from "../lib/time.js";

export function latestPosition(row: Candidate, edge: "start" | "end") {
  return row.chain.findLast(pass => pass.edge === edge)?.at ?? row[edge];
}

/** The grader consumes a whole-second window relative to the sent bytes. The
 * original source counts and the pass that supplied them stay on the proposal. */
export function proposalWindow(row: Candidate, clock: RangeClock, legacy?: IndexedMoment): IndexedMoment | undefined {
  const first = BigInt(latestPosition(row, "start"));
  const last = BigInt(latestPosition(row, "end"));
  const end = clock.observedEnd;
  if (last <= clock.from || (end !== undefined && first >= end)) return;
  if (legacy && !row.chain.length) {
    // Original whole seconds can straddle native grid boundaries. Reuse the
    // released window only when it describes this validated proposal.
    const start = clock.sourceIndex(clock.unitsForSeconds(timestampToSeconds(legacy.start)));
    const stop = clock.sourceIndex(clock.unitsForSeconds(timestampToSeconds(legacy.end), true));
    if (start === first && (end !== undefined && end < stop ? end : stop) === last) return {...legacy};
  }
  const {num, den} = clock.grid.rate;
  const startCount = first <= clock.from ? 0n : first - clock.from;
  const endCount = (end !== undefined && end < last ? end : last) - clock.from;
  const startSeconds = Number(startCount * BigInt(den) / BigInt(num));
  const endSeconds = Number((endCount * BigInt(den) + BigInt(num - 1)) / BigInt(num));
  return {start:secondsToTimestamp(startSeconds), end:secondsToTimestamp(endSeconds),
    kind:"Candidate", summary:"External proposal", importance:"medium"};
}
