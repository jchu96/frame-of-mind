import { z } from "zod";

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
const scalar = z.strictObject({name, type:z.enum(["string","boolean","number","integer"]),
  description:z.string().min(1).max(4000), enum:z.array(z.string().max(500)).min(1).max(100).optional()});
const field = z.union([scalar,scalar.extend({type:z.literal("time_array"),
  items:z.strictObject({type:z.literal("object"),fields:z.array(scalar).min(1).max(20)})}),
  scalar.extend({type:z.literal("array"),items:z.strictObject({type:z.enum(["string","number","integer","boolean"])})})]);
const referenceImage = z.strictObject({name,media_type:z.literal("image"),
  base64_string:z.base64().min(4).max(Math.ceil(32_000_000/3)*4)});
export const segmentDefinitions = z.array(z.strictObject({
  id:name, media_sources:z.array(referenceImage).max(4).optional(), description:z.string().min(1).max(4000), fields:z.array(field).min(1).max(20),
})).min(1).max(20).refine(defs=>new Set(defs.map(d=>d.id)).size===defs.length,"Duplicate definition ID.");
export type SegmentDefinitions = z.infer<typeof segmentDefinitions>;
