import type { FrameRate } from "exact-time";

interface MeasuredRate { framesPerSecond: number; gapMs: number; share: number }
export type FrameTiming =
  | { varying: boolean; frames: number; averageFramesPerSecond: number; rates: MeasuredRate[]; oddGaps: number; oddShare: number }
  | { varying: null; frames: number | null; unread: "too few frames" | "no picture" | "frames with no time" | "scan limit" | "unavailable"; untimedFrames?: number };

const minimumRun = 5;
const rounded = (value: number, digits: number) => Number(value.toFixed(digits));

export function parseFrameTick(value?: string): FrameRate | undefined {
  const match = /^(\d+)\/(\d+)(?:,|\s|$)/.exec(value ?? "");
  const num = Number(match?.[1]), den = Number(match?.[2]);
  if (Number.isSafeInteger(num) && num > 0 && Number.isSafeInteger(den) && den > 0) return {num, den};
}

export function classifyFrameTiming(pts: readonly (number | undefined)[], tick?: FrameRate): FrameTiming {
  if (!tick || !Number.isSafeInteger(tick.num) || !Number.isSafeInteger(tick.den) || tick.num <= 0 || tick.den <= 0) {
    throw new Error("Unreadable frame time unit.");
  }
  const valid = pts.filter((t): t is number => Number.isSafeInteger(t));
  if (valid.length !== pts.length) {
    return {varying: null, frames: pts.length, unread: "frames with no time", untimedFrames: pts.length - valid.length};
  }
  const times = [...new Set(valid)].sort((a, b) => a - b);
  if (times.length < 3) return {varying: null, frames: times.length, unread: "too few frames"};

  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  const frequency = new Map<number, {count: number; longest: number}>();
  let consecutive = 0;
  for (const [i, gap] of gaps.entries()) {
    consecutive = gap === gaps[i - 1] ? consecutive + 1 : 1;
    const stat = frequency.get(gap) ?? {count: 0, longest: 0};
    stat.count++;
    stat.longest = Math.max(stat.longest, consecutive);
    frequency.set(gap, stat);
  }

  // Assign rounded neighbours to the most frequent gap first. A sustained
  // neighbouring gap keeps its own rate even on a coarse stream clock.
  type Group = {count: number; held: number; heldTicks: number};
  const membership = new Map<number, Group>();
  const groups: Group[] = [];
  for (const [gap] of [...frequency].sort(([a, x], [b, y]) => y.count - x.count || a - b)) {
    if (membership.has(gap)) continue;
    const group = {count: 0, held: 0, heldTicks: 0};
    groups.push(group);
    for (const member of [gap, gap - 1, gap + 1]) {
      const stat = frequency.get(member);
      if (!stat || membership.has(member) || (member !== gap && stat.longest >= minimumRun)) continue;
      membership.set(member, group);
      group.count += stat.count;
    }
  }

  const main = groups.reduce((a, b) => b.count > a.count ? b : a);
  let oddGaps = 0;
  for (let start = 0; start < gaps.length;) {
    const group = membership.get(gaps[start]!)!;
    let end = start, ticks = 0;
    do { ticks += gaps[end++]!; } while (end < gaps.length && membership.get(gaps[end]!) === group);
    const count = end - start;
    if (group === main || count >= minimumRun) {
      group.held += count;
      group.heldTicks += ticks;
    } else oddGaps += count;
    start = end;
  }
  const secondsPerTick = tick.num / tick.den;
  const rates = groups.filter(group => group.held).sort((a, b) => b.held - a.held).map(group => {
    const seconds = secondsPerTick * group.heldTicks;
    return {framesPerSecond: rounded(group.held / seconds, 3), gapMs: rounded(seconds * 1000 / group.held, 3),
      share: rounded(group.held / gaps.length, 4)};
  });
  const oddShare = oddGaps / gaps.length;
  const duration = (times.at(-1)! - times[0]!) * secondsPerTick;
  return {varying: rates.length > 1 || (oddGaps >= 2 && oddShare > 0.01), frames: times.length,
    averageFramesPerSecond: rounded(gaps.length / duration, 3), rates, oddGaps, oddShare: rounded(oddShare, 6)};
}

export function frameTimingSentence(name: string, timing: FrameTiming): string {
  if (!timing.varying) return "";
  const rates = timing.rates.slice(0, 3).map(rate => rounded(rate.framesPerSecond, 1));
  const detail = rates.length > 1 ? `about ${rates.join(" and ")} frames a second across the clip` : "its frames are not evenly spaced";
  return `${JSON.stringify(name)} has a frame rate that varies (${detail}), so a cut on one frame grid can land one frame off.`;
}
