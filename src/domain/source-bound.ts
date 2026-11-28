import type { FrameRate } from "exact-time";
import { z } from "zod";
import { rateSchema, sameRate } from "./media-clock.js";
import type { RangeClock } from "./range-clock.js";

export const indexSchema = z.string().regex(/^(0|[1-9]\d*)$/, {abort:true});
const provenance = z.discriminatedUnion("origin", [
  z.object({ origin: z.literal("cut"), precisionMs: z.literal(0) }),
  z.object({ origin: z.literal("snap"), precisionMs: z.union([z.literal(50), z.literal(200), z.literal(300)]), gridMs: z.literal(10) }),
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
const boundKeys = z.strictObject({
  clock: z.unknown(), unit: z.unknown(), origin: z.unknown(), precisionMs: z.unknown(),
  frames: z.unknown().optional(), samples: z.unknown().optional(), rate: z.unknown().optional(),
  tick: z.unknown().optional(), ticks: z.unknown().optional(), support: z.unknown().optional(), gridMs: z.unknown().optional(),
}).superRefine((value, ctx) => {
  const coordinateKeys = value.unit === "tick" ? ["tick", "ticks"] : ["rate", value.unit === "sample" ? "samples" : "frames"];
  const keys = ["clock", "unit", "origin", "precisionMs", ...coordinateKeys];
  if (value.origin === "snap") keys.push("gridMs");
  if (value.origin === "model") keys.push("support");
  if (Object.keys(value).some(key => !keys.includes(key))) ctx.addIssue({code:"custom", message:"Fields must match the bound unit and origin."});
});
export const boundSchema = boundKeys.pipe(z.intersection(coordinate, provenance)).superRefine((b, ctx) => {
  if (b.origin !== "model") return;
  const [a, end] = b.support.map(BigInt) as [bigint, bigint];
  const index = boundIndex(b);
  const rate = boundRate(b);
  // Fractional frame periods may include a partial cell at each edge.
  const maxCells = (BigInt(rate.num) + BigInt(rate.den) - 1n) / BigInt(rate.den) + 1n;
  if (a >= end || index < a || index > end || end - a > maxCells) {
    ctx.addIssue({code: "custom", message: "Model support must contain its position within the stated second."});
  }
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
export function humanTime(b: Bound) {
  const rate = boundRate(b);
  const s = boundIndex(b) * BigInt(rate.den) / BigInt(rate.num);
  return [s / 3600n, s / 60n % 60n, s % 60n].map(n => String(n).padStart(2, "0")).join(":");
}

/**
 * Window offsets are grid indices on the cut. The model supplies whole seconds relative to the sent window.
 * A stated second becomes the first unit at or after it, so the text computed from the exact value is the
 * second the model stated at every rate; `support` stays every unit that second touches.
 */
export function modelBound(clock: RangeClock, second: number, readStart: bigint, readEnd: bigint | undefined, exclusive = false): Bound {
  const at = (s: number, ceil = false) => clock.sourceIndex(readStart + clock.unitsForSeconds(s, ceil));
  const low = at(second);
  const upper = at(second + 1, true);
  const end = readEnd === undefined ? upper : clock.sourceIndex(readEnd);
  const index = at(second, true);
  if (low >= end || index >= end) return sourceBound(clock, end);
  return sourceBound(clock, index, {origin:"model", precisionMs:1000, support:[String(low), String(upper < end ? upper : end)]});
}
export function modelSpan(clock: RangeClock, start: number, end: number, readStart = 0n, readEnd = clock.cutLength): ExactSpan | undefined {
  const a = modelBound(clock, start, readStart, readEnd);
  const b = modelBound(clock, end, readStart, readEnd, true);
  return boundIndex(a) < boundIndex(b) ? { start: a, endExclusive: b } : undefined;
}
