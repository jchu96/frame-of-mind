import { z } from "zod";
import type { MediaClock } from "./media-clock.js";

declare const clockBrand: unique symbol;
export type ClockTime<C extends string = MediaClock> = {
  clock: C; ms: number; precisionMs: number; readonly [clockBrand]: C;
};
export type SourceTime = ClockTime<"source">;
export type FileClock = "source" | "reel";
export type ClipClock = "absolute" | "relative" | "unverified";

export function clockTime<C extends string>(clock: C, ms: number, precisionMs = 1000): ClockTime<C> {
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(precisionMs) || precisionMs < 0) {
    throw new Error("Clock values must be safe integer milliseconds.");
  }
  return { clock, ms, precisionMs } as ClockTime<C>;
}

export function parseSecondsMs(value: string): number {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value) || value.trim() !== value) {
    throw new Error("Seconds must be non-negative, unsigned decimal seconds with at most three decimals.");
  }
  const [whole, fraction = ""] = value.split(".");
  const ms = BigInt(whole!) * BigInt(1000) + BigInt(fraction.padEnd(3, "0"));
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Seconds exceed the safe millisecond range.");
  return Number(ms);
}

export function sourceToTimeline(time: SourceTime, offsetMs: number): ClockTime<"timeline"> {
  return fileToTimeline(time, offsetMs);
}
export function fileToTimeline(time: ClockTime<FileClock>, offsetMs: number): ClockTime<"timeline"> {
  if (!Number.isSafeInteger(offsetMs) || offsetMs < 0) throw new Error("Invalid timeline offset.");
  return clockTime("timeline", time.ms + offsetMs, time.precisionMs);
}
export function timelineToSource(time: ClockTime<"timeline">, offsetMs: number): SourceTime {
  return clockTime("source", time.ms - offsetMs, time.precisionMs);
}
function signedSecondsMs(value: number): number {
  return (value < 0 ? -1 : 1) * parseSecondsMs(String(Math.abs(value)));
}
export function transcriptToFile(time: ClockTime<"transcript">, offsetSeconds: number): SourceTime {
  return clockTime("source", time.ms - signedSecondsMs(offsetSeconds), time.precisionMs);
}
export function clipToFile(time: ClockTime<"clip">, clipStartSeconds: number, mode: ClipClock): SourceTime {
  return clockTime("source", time.ms + (mode === "relative" ? signedSecondsMs(clipStartSeconds) : 0), time.precisionMs);
}

const safeNatural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = safeNatural.min(1);
export const rateSchema = z.strictObject({ num: positiveInteger, den: positiveInteger });
export type FrameRate = z.infer<typeof rateSchema>;
export const timecodeSpecSchema = z.strictObject({
  rate: rateSchema, dropFrame: z.boolean(), rateOrigin: z.enum(["declared", "media"]),
}).refine((v) => !v.dropFrame || isDropRate(v.rate), "Drop-frame requires 30000/1001 or 60000/1001.");
export type TimecodeSpec = z.infer<typeof timecodeSpecSchema>;
export const clockDeclarationSchema = z.strictObject({
  timelineOffsetMs: safeNatural, origin: z.literal("declared"), timecode: timecodeSpecSchema.optional(),
});
export type ClockDeclaration = z.infer<typeof clockDeclarationSchema>;
export const runClockSchema = z.strictObject({
  fileClock: z.enum(["source", "reel"]),
  timeline: clockDeclarationSchema.optional(),
  modelClipClock: z.enum(["absolute", "relative", "unverified"]),
  calibration: z.strictObject({ model: z.string().min(1).max(240), checkedAt: z.iso.datetime(), method: z.literal("synthetic-flash") }).optional(),
  relativeEvidenceResponses: safeNatural.optional(),
  clipGuard: z.enum(["applied", "unknown-duration"]).optional(),
  transcriptClock: z.enum(["exact-ms", "unverified"]).optional(),
  transcriptWindow: z.enum(["windowed", "not-windowed", "not-requested"]).optional(),
});
export type RunClock = z.infer<typeof runClockSchema>;

export const ACCEPTED_RATES = "24, 25, 30, 48, 50, 60; 23.976, 47.952; 29.97df, 29.97ndf, 59.94df, 59.94ndf; N/D (optionally :df or :ndf); from-media, from-media:df, from-media:ndf";
function rateError(): never { throw new Error(`Unsupported or ambiguous timecode rate. Accepted forms: ${ACCEPTED_RATES}. Drop-frame must be stated for 30000/1001 and 60000/1001.`); }
export function rationalRate(num: number, den: number): FrameRate {
  rateSchema.parse({ num, den });
  let a = num; let b = den;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  return { num: num / a, den: den / a };
}
export function isDropRate(rate: FrameRate): boolean {
  return BigInt(rate.num) * BigInt(1001) === BigInt(30000) * BigInt(rate.den)
    || BigInt(rate.num) * BigInt(1001) === BigInt(60000) * BigInt(rate.den);
}
export function parseTimecodeRate(value: string): TimecodeSpec {
  const match = /^(.*?)(?::?(ndf|df))?$/.exec(value);
  if (!match || match[0] !== value) rateError();
  const name = match[1]!; const choice = match[2];
  const aliases: Record<string, FrameRate> = {
    "23.976": { num: 24000, den: 1001 }, "47.952": { num: 48000, den: 1001 },
    "29.97": { num: 30000, den: 1001 }, "59.94": { num: 60000, den: 1001 },
  };
  let rate = Object.hasOwn(aliases, name) ? aliases[name] : undefined;
  if (!rate && /^(24|25|30|48|50|60)$/.test(name)) rate = { num: Number(name), den: 1 };
  if (!rate && /^[1-9]\d*\/[1-9]\d*$/.test(name)) {
    const [num, den] = name.split("/").map(Number);
    try { rate = rationalRate(num!, den!); } catch { rateError(); }
  }
  if (!rate || (isDropRate(rate) && !choice) || (choice === "df" && !isDropRate(rate))) rateError();
  return { rate, dropFrame: choice === "df", rateOrigin: "declared" };
}
export function declareClock(offset?: string, rate?: string): ClockDeclaration | undefined {
  if (rate !== undefined && offset === undefined) throw new Error("--timecode-rate requires --timeline-offset (use 0 for a sequence starting at zero).");
  if (offset === undefined) return undefined;
  return clockDeclarationSchema.parse({
    timelineOffsetMs: parseSecondsMs(offset), origin: "declared",
    ...(rate !== undefined && !/^from-media(?::(?:df|ndf))?$/.test(rate) ? { timecode: parseTimecodeRate(rate) } : {}),
  });
}

/** Rendering only: the exact rational frame containing the millisecond instant. */
export function renderTimecode(ms: number, rate: FrameRate, dropFrame = false): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("Timecode requires non-negative integer milliseconds.");
  rateSchema.parse(rate);
  if (dropFrame && !isDropRate(rate)) rateError();
  const numerator = BigInt(rate.num); const denominator = BigInt(rate.den);
  const nominal = (numerator + denominator - BigInt(1)) / denominator;
  let frame = BigInt(ms) * numerator / (BigInt(1000) * denominator);
  if (dropFrame) {
    const drop = nominal === BigInt(60) ? BigInt(4) : BigInt(2);
    const tenMinutes = nominal * BigInt(600) - drop * BigInt(9);
    const minute = nominal * BigInt(60) - drop;
    const remainder = frame % tenMinutes;
    frame += drop * BigInt(9) * (frame / tenMinutes)
      + (remainder >= drop ? drop * ((remainder - drop) / minute) : BigInt(0));
  }
  const ff = frame % nominal;
  const seconds = frame / nominal;
  const fields = [seconds / BigInt(3600), seconds / BigInt(60) % BigInt(60), seconds % BigInt(60)].map(v => String(v).padStart(2, "0"));
  return `${fields.join(":")}${dropFrame ? ";" : ":"}${String(ff).padStart(2, "0")}`;
}
