import { z } from "zod";
import { timecodeSpecSchema, parseTimecodeRate, type FrameRate } from "./time-rate.js";
export * from "./time-rate.js";
import { fromMilliseconds, renderExactTimecode } from "./exact-time.js";
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

export function declareClock(offset?: string, rate?: string): ClockDeclaration | undefined {
  if (rate !== undefined && offset === undefined) throw new Error("--timecode-rate requires --timeline-offset (use 0 for a sequence starting at zero).");
  if (offset === undefined) return undefined;
  return clockDeclarationSchema.parse({
    timelineOffsetMs: parseSecondsMs(offset), origin: "declared",
    ...(rate !== undefined && !/^from-media(?::(?:df|ndf))?$/.test(rate) ? { timecode: parseTimecodeRate(rate) } : {}),
  });
}

/** Compatibility rendering: the frame containing the whole-millisecond instant. */
export function renderTimecode(ms: number, rate: FrameRate, dropFrame: boolean): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("Timecode requires non-negative integer milliseconds.");
  return renderExactTimecode(fromMilliseconds("source", String(ms), rate), dropFrame);
}
