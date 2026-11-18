import { z } from "zod";
import { mediaClockSchema } from "./media-clock.js";
import { rateSchema, isDropRate } from "./time-rate.js";
const whole = z.string().regex(/^(0|[1-9]\d*)$/);
const seconds = z.string().regex(/^(0|[1-9]\d*)\.\d{3}$/);
const approximate = z.strictObject({
  clock: mediaClockSchema, seconds, precisionMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), origin: z.literal("model"),
});
const exactCommon = { clock: mediaClockSchema, seconds: seconds.optional(), secondsDerived: z.literal(true), secondsUnavailable: z.string().min(1).optional(), origin: z.literal("declared"), ticks: whole.optional(), ticksUnavailable: z.string().min(1).optional() };
const exact = z.union([
  z.strictObject({ ...exactCommon, frames: whole, rate: rateSchema, timecode: z.string().min(1), dropFrame: z.boolean() })
    .refine(v => !v.dropFrame || isDropRate(v.rate), "Invalid drop-frame rate."),
  z.strictObject({ ...exactCommon, milliseconds: whole, rateBasis: z.literal("whole-millisecond source; no declared video rate") }),
]).refine(v => (v.ticks !== undefined) !== (v.ticksUnavailable !== undefined), "Ticks must be exact or explicitly unavailable.")
  .refine(v => (v.seconds !== undefined) !== (v.secondsUnavailable !== undefined), "Derived seconds must be present or explicitly unavailable.");
export const timesSchema = z.strictObject({
  schemaVersion: z.literal(2), kind: z.literal("frame-of-mind.times"), fileClock: z.enum(["source", "reel"]),
  exactTimeCapability: z.enum(["declared video rate: frames, timecode with explicit drop-frame, ticks when whole, derived seconds when a whole millisecond exists", "no declared video rate: whole milliseconds, seconds and ticks; no frames or timecode", "legacy millisecond offset: milliseconds, seconds and ticks; no exact video-frame boundary"]),
  timeline: z.strictObject({ offset: exact }).optional(),
  entries: z.array(z.strictObject({ pointer: z.string().startsWith("/"), time: approximate, timeline: approximate.optional() })),
});
export type TimesArtifact = z.infer<typeof timesSchema>;
