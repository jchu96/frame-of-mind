import { z } from "zod";
import { timecodeSpecSchema, parseTimecodeRate, type FrameRate, type TimecodeSpec } from "./time-rate.js";
export * from "./time-rate.js";
import { exactTime, exactMilliseconds, fromBoundaryMilliseconds, fromTimecode, fromMilliseconds, renderExactTimecode, type ExactTime } from "./exact-time.js";
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
const exactOffsetSchema = z.strictObject({
  clock: z.literal("timeline"), frames: z.string().regex(/^(0|[1-9]\d*)$/),
  rate: z.strictObject({ num: safeNatural.min(1), den: safeNatural.min(1) }), unit: z.enum(["video-frame", "millisecond"]),
}).superRefine((value, ctx) => {
  if (value.unit === "millisecond" && (value.rate.num !== 1000 || value.rate.den !== 1)) ctx.addIssue({ code: "custom", message: "Millisecond sources require internal rate 1000/1." });
});
export const clockDeclarationSchema = z.strictObject({
  timelineOffsetMs: safeNatural.optional(), exactOffset: exactOffsetSchema.optional(),
  origin: z.literal("declared"), timecode: timecodeSpecSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.timelineOffsetMs === undefined && !value.exactOffset) ctx.addIssue({ code: "custom", message: "A timeline offset is required." });
  if (value.exactOffset) {
    const stored = value.exactOffset;
    const exact = stored.unit === "millisecond" ? fromMilliseconds("timeline", stored.frames) : exactTime("timeline", stored.frames, stored.rate);
    if (exact.rate.num !== stored.rate.num || exact.rate.den !== stored.rate.den) ctx.addIssue({ code: "custom", message: "Exact offset rate must be reduced." });
    if (value.timelineOffsetMs !== undefined && exactMilliseconds(exact) !== String(value.timelineOffsetMs)) ctx.addIssue({ code: "custom", message: "Millisecond offset must be exact and agree with the frame offset." });
    if (stored.unit === "video-frame" && (!value.timecode || value.timecode.rate.num !== stored.rate.num || value.timecode.rate.den !== stored.rate.den)) ctx.addIssue({ code: "custom", message: "Video offset requires its matching declared rate and drop-frame choice." });
  }
});
export type ClockDeclaration = z.infer<typeof clockDeclarationSchema>;
/** Legacy manifests may have millisecond offsets between frames; keep their original unit. */
export function declaredOffset(declaration: ClockDeclaration): ExactTime<"timeline"> {
  const value = declaration.exactOffset;
  if (value) return value.unit === "millisecond" ? fromMilliseconds("timeline", value.frames) : exactTime("timeline", value.frames, value.rate);
  return fromMilliseconds("timeline", String(declaration.timelineOffsetMs!));
}
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

export function declareClock(offset?: string, rate?: string, mediaRate?: TimecodeSpec): ClockDeclaration | undefined {
  if (rate !== undefined && offset === undefined) throw new Error("--timecode-rate requires --timeline-offset (use 0 for a sequence starting at zero).");
  if (offset === undefined) return undefined;
  const fromMedia = rate !== undefined && /^from-media(?::(?:df|ndf))?$/.test(rate);
  const frameInput = /^(0|[1-9]\d*)f$/.test(offset) && offset.trim() === offset;
  const codeInput = /^(\d{2}|[1-9]\d{2,}):[0-5]\d:[0-5]\d[:;](\d{2}|[1-9]\d{2,})$/.test(offset) && offset.trim() === offset;
  let ms: number | undefined;
  if (!frameInput && !codeInput) {
    try { ms = parseSecondsMs(offset); }
    catch { throw new Error("Accepted --timeline-offset forms: non-negative seconds (at most three decimals), Nf whole frames, or HH:MM:SS:FF / HH:MM:SS;FF at a declared video rate. Time of day is not a cut point."); }
  }
  if (fromMedia && !mediaRate) return undefined; // Validated syntax; resolve only after the exact media probe.
  const spec = fromMedia ? mediaRate : rate !== undefined ? parseTimecodeRate(rate) : undefined;
  if ((frameInput || codeInput) && !spec) throw new Error("Frame/timecode offsets require --timecode-rate. Without it, use seconds (at most three decimals); exact outputs are milliseconds, seconds and ticks, with no frames or timecode.");
  const time = frameInput ? exactTime("timeline", offset.slice(0, -1), spec!.rate)
    : codeInput ? fromTimecode("timeline", offset, spec!.rate, spec!.dropFrame)
    : spec ? fromBoundaryMilliseconds("timeline", String(ms!), spec.rate) : fromMilliseconds("timeline", String(ms!));
  const exactMs = exactMilliseconds(time);
  return clockDeclarationSchema.parse({
    exactOffset: { clock: time.clock, frames: String(time.frames), rate: time.rate, unit: time.unit },
    ...(exactMs !== undefined && BigInt(exactMs) <= BigInt(Number.MAX_SAFE_INTEGER) ? { timelineOffsetMs: Number(exactMs) } : {}),
    origin: "declared", ...(spec ? { timecode: spec } : {}),
  });
}

/** Compatibility rendering: the frame containing the whole-millisecond instant. */
export function renderTimecode(ms: number, rate: FrameRate, dropFrame: boolean): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("Timecode requires non-negative integer milliseconds.");
  return renderExactTimecode(fromMilliseconds("source", String(ms), rate), dropFrame);
}
