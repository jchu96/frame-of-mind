import { boundSchema } from "./source-bound.js";
import { z } from "zod";
import { mediaClockSchema, rateSchema, timecodeSpecSchema } from "./media-clock.js";
const whole = z.string().regex(/^(0|[1-9]\d*)$/);
const seconds = z.string().regex(/^(0|[1-9]\d*)\.\d{3}$/);
const approximate = z.strictObject({
  clock: mediaClockSchema, seconds, precisionMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), origin: z.literal("model"),
});
const exactCommon = { clock: mediaClockSchema, seconds: seconds.optional(), secondsDerived: z.literal(true), secondsUnavailable: z.string().min(1).optional(), origin: z.literal("declared"), ticks: whole.optional(), ticksUnavailable: z.string().min(1).optional() };
const exact = z.union([
  z.strictObject({ ...exactCommon, frames: whole, rate: rateSchema, timecode: z.string().min(1), dropFrame: z.boolean() })
    .superRefine(({ rate, dropFrame, origin }, ctx) => {
      const spec = timecodeSpecSchema.safeParse({ rate, dropFrame, rateOrigin: origin });
      if (!spec.success) {
        for (const issue of spec.error.issues) ctx.addIssue({ code: "custom", message: issue.message });
      }
    }),
  z.strictObject({ ...exactCommon, milliseconds: whole, rateBasis: z.literal("whole-millisecond source; no declared video rate") }),
]).refine(v => (v.ticks !== undefined) !== (v.ticksUnavailable !== undefined), "Ticks must be exact or explicitly unavailable.")
  .refine(v => (v.seconds !== undefined) !== (v.secondsUnavailable !== undefined), "Derived seconds must be present or explicitly unavailable.");
export const timesV2Schema = z.strictObject({
  schemaVersion: z.literal(2), kind: z.literal("frame-of-mind.times"), fileClock: z.enum(["source", "reel"]),
  exactTimeCapability: z.enum(["declared video rate: frames, timecode with explicit drop-frame, ticks when whole, derived seconds when a whole millisecond exists", "no declared video rate: whole milliseconds, seconds and ticks; no frames or timecode", "legacy millisecond offset: milliseconds, seconds and ticks; no exact video-frame boundary"]),
  timeline: z.strictObject({ offset: exact }).optional(),
  entries: z.array(z.strictObject({ pointer: z.string().startsWith("/"), exactTime:boundSchema.optional(), time: approximate, timeline: approximate.optional() })),
});

const fileClock = z.enum(["source", "reel"]);
const measured = approximate.extend({ gridMs: z.literal(10), precisionMs: z.literal([50, 200]), origin: z.literal("audio-envelope") });
const naturalMs = z.number().int().nonnegative();
const alternativesMs = z.array(naturalMs).refine(xs => xs.every((x, i) => i === 0 || xs[i - 1]! < x));
const frameReference = z.strictObject({
  clock: z.literal("timeline"), frames: whole, rate: rateSchema, dropFrame: z.boolean(),
  timecode: z.string().min(1), basis: z.enum(["onset", "last-speech-ms"]),
});
const snap = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("snapped"), exactTime:boundSchema.optional(), exactAlternatives:z.array(boundSchema).optional(), target: measured.extend({ clock: fileClock, seconds: seconds.endsWith("0") }),
    timeline: measured.extend({ clock: z.literal("timeline") }).optional(), shiftMs: z.number().int(),
    gapMs: naturalMs, gapLowerBound: z.literal(true).optional(), alternativesMs, frameReference: frameReference.optional() }),
  z.strictObject({ status: z.literal("no-boundary"), exactAlternatives:z.array(boundSchema).optional(), alternativesMs }),
  z.strictObject({ status: z.literal("ambiguous"), exactAlternatives:z.array(boundSchema).optional(), alternativesMs: alternativesMs.refine(xs => xs.length > 0) }),
  z.strictObject({ status: z.literal("unavailable") }),
]);
export type StoredSnap = z.infer<typeof snap>;
const model = approximate.extend({ precisionMs: z.literal(1000) });
const entry = z.strictObject({ pointer: z.string(), exactTime:boundSchema.optional(), time: model.extend({ clock: fileClock, seconds: seconds.endsWith(".000") }),
  timeline: model.extend({ clock: z.literal("timeline") }).optional() });
const timesV3Schema = timesV2Schema.extend({
  schemaVersion: z.literal(3),
  snapSettings: z.strictObject({ method: z.literal("audio-envelope"), gapMs: naturalMs.min(80).max(2000), windowMs: naturalMs.min(250).max(3000) }),
  entries: z.array(z.union([
    entry.extend({ pointer: z.string().regex(/^\/items\/(0|[1-9]\d*)\/candidate\/(start|end)$/), snap }),
    entry.extend({ pointer: z.string().regex(/^\/items\/(0|[1-9]\d*)\/result\/evidence\/timestamp$/) }),
  ])),
}).superRefine((run, ctx) => {
  for (const [i, e] of run.entries.entries()) {
    const measured = "snap" in e && e.snap.status === "snapped" ? e.snap : undefined;
    if (e.time.clock !== run.fileClock || !!e.timeline !== !!run.timeline ||
        (measured && (measured.target.clock !== run.fileClock || !!measured.timeline !== !!run.timeline ||
          (measured.timeline && measured.timeline.precisionMs !== measured.target.precisionMs) ||
          measured.gapMs < run.snapSettings.gapMs || Math.abs(measured.shiftMs) > run.snapSettings.windowMs))) {
      ctx.addIssue({ code: "custom", path: ["entries", i], message: "Reading disagrees with run clock or snap settings." });
    }
    const ref = measured?.frameReference;
    const needsFrame = !!measured && !!run.timeline && !run.exactTimeCapability.startsWith("no declared");
    if (!!ref !== needsFrame) ctx.addIssue({ code: "custom", path: ["entries", i], message: "Frame reference disagrees with run capability." });
    const offset = run.timeline?.offset;
    if (ref && offset && "frames" in offset && (offset.rate.num !== ref.rate.num || offset.rate.den !== ref.rate.den || offset.dropFrame !== ref.dropFrame)) {
      ctx.addIssue({ code: "custom", path: ["entries", i], message: "Frame reference disagrees with declared sequence rate." });
    }
    if (ref && (!run.timeline || run.exactTimeCapability.startsWith("no declared") ||
        ref.basis !== (e.pointer.endsWith("/start") ? "onset" : "last-speech-ms") ||
        !timecodeSpecSchema.safeParse({ rate: ref.rate, dropFrame: ref.dropFrame, rateOrigin: "declared" }).success)) {
      ctx.addIssue({ code: "custom", path: ["entries", i], message: "Invalid containing-frame reference." });
    }
  }
});
export const timesSchema = z.discriminatedUnion("schemaVersion", [timesV2Schema, timesV3Schema]);
export type TimesArtifact = z.infer<typeof timesSchema>;
