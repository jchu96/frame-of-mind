import type { FrameRate } from "exact-time";
import { z } from "zod";
import { rateSchema, sameRate } from "./media-clock.js";
import type { RangeClock } from "./range-clock.js";
import { secondsToTimestamp } from "../lib/time.js";

export const indexSchema = z.string().regex(/^(0|[1-9]\d*)$/, {abort:true});
const provenance = z.discriminatedUnion("origin", [
  z.object({ origin: z.literal("cut"), precisionMs: z.literal(0) }),
  z.object({ origin: z.literal("snap"), precisionMs: z.union([z.literal(50), z.literal(200)]), gridMs: z.literal(10) }),
  z.object({ origin: z.literal("model"), precisionMs: z.literal(1000), support: z.tuple([indexSchema, indexSchema]) }),
]);
type Provenance = z.infer<typeof provenance>;
const source = { clock: z.literal("source") };
const coordinate = z.discriminatedUnion("unit", [
  z.object({ ...source, unit: z.literal("video-frame"), frames: indexSchema, rate: rateSchema }),
  z.object({ ...source, unit: z.literal("sample"), samples: indexSchema, rate: rateSchema }),
  z.object({ ...source, unit: z.literal("tick"), ticks: indexSchema, tick: rateSchema }),
]);
export type Bound = z.infer<typeof coordinate> & Provenance;
export const boundIndex = (b: Bound) => BigInt(b.unit === "video-frame" ? b.frames : b.unit === "sample" ? b.samples : b.ticks);
export const boundRate = (b: Bound): FrameRate => b.unit === "tick" ? { num: b.tick.den, den: b.tick.num } : b.rate;
export const boundSchema = z.intersection(coordinate, provenance).superRefine((b, ctx) => {
  if (b.origin !== "model" || !b.support.every(s => indexSchema.safeParse(s).success)) return;
  const [a, end] = b.support.map(BigInt) as [bigint, bigint];
  if (a >= end) ctx.addIssue({code: "custom", message: "Empty model support."});
});
export const exactSpanSchema = z.strictObject({ start: boundSchema, endExclusive: boundSchema }).refine(({start, endExclusive}) => {
  if (start.unit !== endExclusive.unit || !sameRate(boundRate(start), boundRate(endExclusive))) return false;
  try { return boundIndex(start) < boundIndex(endExclusive); } catch { return false; }
}, "A source span must have increasing bounds on one grid.");
export type ExactSpan = z.infer<typeof exactSpanSchema>;

export function sourceBound(clock: RangeClock, index: bigint, provenance: Provenance = { origin: "cut", precisionMs: 0 }): Bound {
  const {rate, unit} = clock.grid;
  const base = {clock: "source" as const, ...provenance};
  if (unit === "ticks") return {...base, unit: "tick", ticks: String(index), tick: {num: rate.den, den: rate.num}};
  return unit === "frames" ? {...base, unit: "video-frame", frames: String(index), rate}
    : {...base, unit: "sample", samples: String(index), rate};
}

export function boundMillis(b: Bound, ceil = false) {
  const rate = boundRate(b);
  return Number((boundIndex(b) * 1000n * BigInt(rate.den) + (ceil ? BigInt(rate.num - 1) : 0n)) / BigInt(rate.num));
}
export const humanTime = (b: Bound) => secondsToTimestamp(boundMillis(b) / 1000);

/** Window offsets are grid indices on the cut. The model supplies whole seconds relative to the sent window. */
export function modelBound(clock: RangeClock, second: number, readStart: bigint, readEnd: bigint | undefined, exclusive = false): Bound {
  const at = (s: number, ceil = false) => clock.sourceIndex(readStart + clock.unitsForSeconds(s, ceil));
  const low = at(second);
  const upper = at(second + 1, true);
  const end = readEnd === undefined ? upper : clock.sourceIndex(readEnd);
  const index = at(second, exclusive);
  if (low >= end || index >= end) return sourceBound(clock, end);
  return sourceBound(clock, index, {origin:"model", precisionMs:1000, support:[String(low), String(upper < end ? upper : end)]});
}
export function modelSpan(clock: RangeClock, start: number, end: number, readStart = 0n, readEnd = clock.cutLength): ExactSpan | undefined {
  const a = modelBound(clock, start, readStart, readEnd);
  const b = modelBound(clock, end, readStart, readEnd, true);
  return boundIndex(a) < boundIndex(b) ? { start: a, endExclusive: b } : undefined;
}
