import { z } from "zod";
import { exactSpanSchema, indexSchema } from "./source-bound.js";
import { rateSchema } from "./media-clock.js";

const pair = z.tuple([indexSchema,indexSchema]).refine(([a,b]) =>
  indexSchema.safeParse(a).success && indexSchema.safeParse(b).success && BigInt(a) < BigInt(b), "Expected a positive source span.");
const fragment = z.strictObject({kind:z.enum(["moment","cue"]),state:z.enum(["clipped","unknown"]),exactSpan:exactSpanSchema});
export const rangeFields = z.strictObject({
  requestedRange:z.strictObject({from:z.string().nullable(),to:z.string().nullable()}),
  sourceRange:z.discriminatedUnion("unit", [
    z.strictObject({unit:z.literal("frames"),fromFrame:indexSchema,toFrameExclusive:indexSchema,rate:rateSchema}),
    z.strictObject({unit:z.literal("samples"),fromSample:indexSchema,toSampleExclusive:indexSchema,rate:rateSchema}),
    z.strictObject({unit:z.literal("ticks"),fromTick:indexSchema,toTickExclusive:indexSchema.nullable(),tick:rateSchema}),
  ]),
  edgeMoved:z.strictObject({from:z.boolean(),to:z.boolean()}),
  sourceLengthFrames:indexSchema,sourceLengthSamples:indexSchema,sourceLengthTicks:indexSchema, sourceTiming:z.enum(["unproven","varying"]),
  outputMediaClock:z.literal("source"), uploads:z.array(z.strictObject({kind:z.enum(["audio-window","video-cut"]),span:pair,rate:rateSchema})),
  uploadedCutSha256:z.string().regex(/^[a-f0-9]{64}$/),
  coverage:z.strictObject({full:z.boolean(),covered:z.array(pair)}), maxRangeSeconds:z.number().int().positive(),
  edgeRule:z.literal("both-edges-report-fragments"),endMarginSeconds:z.literal(0), startFragments:z.array(fragment),endFragments:z.array(fragment),
  timePrecision:z.strictObject({modelMs:z.literal(1000),snapGridMs:z.literal(10)}),proseTimeUnverified:z.literal(true),
}).partial();
export type RangeFields = z.infer<typeof rangeFields>;
