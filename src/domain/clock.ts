import { UsageError, ContractError } from "./contract-error.js";
import { z } from "zod";
import {
  exactTime, exactMilliseconds, fromBoundaryMilliseconds, fromTimecode, fromMilliseconds,
  parseTimecodeRate, renderExactTimecode, snapDecimalSeconds, type ExactTime, type FrameRate, type MediaClock, type TimecodeSpec,
} from "exact-time";
import { rateSchema, timecodeSpecSchema } from "./media-clock.js";

export { ACCEPTED_RATES, isDropRate, parseTimecodeRate, rateError, rationalRate, type FrameRate, type TimecodeSpec } from "exact-time";
export { rateSchema, timecodeSpecSchema } from "./media-clock.js";

declare const clockBrand: unique symbol;
export type ClockTime<C extends string = MediaClock> = {
  clock: C; ms: number; precisionMs: number; readonly [clockBrand]: C;
};
export type SourceTime = ClockTime<"source">;
export type FileClock = "source" | "reel";
export type ClipClock = "absolute" | "relative" | "unverified";

export function clockTime<C extends string>(clock: C, ms: number, precisionMs = 1000): ClockTime<C> {
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(precisionMs) || precisionMs < 0) {
    throw new ContractError("INVALID_INPUT", "Clock values must be safe integer milliseconds.");
  }
  return { clock, ms, precisionMs } as ClockTime<C>;
}

export function parseSecondsMs(value: string): number {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value) || value.trim() !== value) {
    throw new ContractError("INVALID_INPUT", "Seconds must be non-negative, unsigned decimal seconds with at most three decimals.");
  }
  const unpadded = value.replace(/^0+(?=\d)/, "");
  const ms = snapDecimalSeconds("timeline", unpadded, { num: 1000, den: 1 }, "instant").frames;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) throw new ContractError("INVALID_INPUT", "Seconds exceed the safe millisecond range.");
  return Number(ms);
}

export function sourceToTimeline(time: SourceTime, offsetMs: number): ClockTime<"timeline"> {
  return fileToTimeline(time, offsetMs);
}
export function fileToTimeline(time: ClockTime<FileClock>, offsetMs: number): ClockTime<"timeline"> {
  if (!Number.isSafeInteger(offsetMs) || offsetMs < 0) throw new ContractError("INVALID_INPUT", "Invalid timeline offset.");
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
  clock: z.literal("timeline"), frames: z.string().regex(/^(0|[1-9]\d*)$/, { abort: true }),
  rate: rateSchema, unit: z.enum(["video-frame", "millisecond"]),
});
export const clockDeclarationSchema = z.strictObject({
  timelineOffsetMs: safeNatural.optional(), exactOffset: exactOffsetSchema.optional(),
  origin: z.literal("declared"), timecode: timecodeSpecSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.timelineOffsetMs === undefined && !value.exactOffset) ctx.addIssue({ code: "custom", message: "A timeline offset is required." });
  if (value.exactOffset) {
    const stored = value.exactOffset;
    const exact = stored.unit === "millisecond" ? fromMilliseconds("timeline", stored.frames) : exactTime("timeline", stored.frames, stored.rate);
    if (exact.rate.num !== stored.rate.num || exact.rate.den !== stored.rate.den) {
      ctx.addIssue({ code: "custom", message: stored.unit === "millisecond"
        ? `Millisecond sources require internal rate ${exact.rate.num}/${exact.rate.den}.`
        : "Exact offset rate must be reduced." });
    }
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

function strictEntry(value: string, flag: string) {
  if (/^(0|[1-9]\d*)f$/.test(value) && value.trim() === value) return { form: "frames", value: value.slice(0, -1) } as const;
  if (/^(\d{2}|[1-9]\d{2,}):[0-5]\d:[0-5]\d[:;](\d{2}|[1-9]\d{2,})$/.test(value) && value.trim() === value) {
    return { form: "timecode", value } as const;
  }
  try { return { form: "milliseconds", value: String(parseSecondsMs(value)) } as const; }
  catch { throw new ContractError("INVALID_INPUT", `Accepted ${flag} forms: non-negative seconds (at most three decimals), Nf whole frames, or HH:MM:SS:FF / HH:MM:SS;FF at a declared video rate. Time of day is not a cut point.`); }
}

function convertEntry<C extends MediaClock>(clock: C, entry: ReturnType<typeof strictEntry>, rate?: FrameRate, dropFrame?: boolean) {
  if (entry.form === "milliseconds") return rate
    ? fromBoundaryMilliseconds(clock, entry.value, rate) : fromMilliseconds(clock, entry.value);
  if (!rate) throw new UsageError("missing-timecode-rate", "Frame/timecode offsets require --timecode-rate. Without it, use seconds (at most three decimals); exact outputs are milliseconds, seconds and ticks, with no frames or timecode.");
  if (entry.form === "frames") return exactTime(clock, entry.value, rate);
  if (dropFrame === undefined) throw new UsageError("missing-drop-frame-mode", "State --timecode-rate with an explicit df or ndf choice for a timecode label.");
  return fromTimecode(clock, entry.value, rate, dropFrame);
}

export function parseFilePosition<C extends FileClock>(clock: C, flag: string, value: string, rate: FrameRate, dropFrame?: boolean): ExactTime<C> {
  return convertEntry(clock, strictEntry(value, flag), rate, dropFrame);
}

export function parseTimelinePosition(value: string, origin: ExactTime<"timeline">, dropFrame?: boolean): { time: ExactTime<"timeline">; absolute: boolean } {
  const entry = strictEntry(value, "--at");
  return { time: convertEntry("timeline", entry, origin.rate, dropFrame), absolute: entry.form === "timecode" };
}

export function declareClock(offset?: string, rate?: string, mediaRate?: TimecodeSpec): ClockDeclaration | undefined {
  if (rate !== undefined && offset === undefined) throw new UsageError("missing-timeline-offset", "--timecode-rate requires --timeline-offset (use 0 for a sequence starting at zero).");
  if (offset === undefined) return undefined;
  const entry = strictEntry(offset, "--timeline-offset");
  const fromMedia = rate !== undefined && /^from-media(?::(?:df|ndf))?$/.test(rate);
  if (fromMedia && !mediaRate) return undefined;
  const spec = fromMedia ? mediaRate : rate !== undefined ? parseTimecodeRate(rate) : undefined;
  const time = convertEntry("timeline", entry, spec?.rate, spec?.dropFrame);
  const exactMs = exactMilliseconds(time);
  return clockDeclarationSchema.parse({
    exactOffset: { clock: time.clock, frames: String(time.frames), rate: time.rate, unit: time.unit },
    ...(exactMs !== undefined && BigInt(exactMs) <= BigInt(Number.MAX_SAFE_INTEGER) ? { timelineOffsetMs: Number(exactMs) } : {}),
    origin: "declared", ...(spec ? { timecode: spec } : {}),
  });
}

/** Compatibility rendering: the frame containing the whole-millisecond instant. */
export function renderTimecode(ms: number, rate: FrameRate, dropFrame: boolean): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new ContractError("INVALID_INPUT", "Timecode requires non-negative integer milliseconds.");
  return renderExactTimecode(fromMilliseconds("source", String(ms), rate), dropFrame);
}
