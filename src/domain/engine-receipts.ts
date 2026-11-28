import { z } from "zod";

export const remoteId = z.string().regex(/^[0-9a-f]{24}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const copyReceipt = z.strictObject({
  receiptId:z.uuid(), operationId:z.uuid(), runId:z.string(), engine:z.literal("twelvelabs"),
  operation:z.enum(["upload","propose","grade"]), accountScope:hash, recordingSha256:hash, sentSha256:hash,
  sentSpan:z.tuple([z.string(),z.string()]), owned:z.literal(true), retention:z.literal("run"),
  retentionSource:z.literal("default"), assetId:remoteId.optional(), taskId:remoteId.optional(),
  createdAt:z.iso.datetime(), checkedAt:z.iso.datetime(), deletedAt:z.iso.datetime().nullable(),
  state:z.enum(["pending","unconfirmed","deleted"]),
  reason:z.enum(["creation-unknown","create-refused","identity-unconfirmed","cleanup","linked","link-check-unavailable","delete-refused","task-pending","unconfirmed-deletion"]).nullable(),
});
export type CopyReceipt = z.infer<typeof copyReceipt>;
const modelCall = z.strictObject({
  role:z.enum(["proposer","grader"]), engine:z.enum(["gemini","twelvelabs"]), model:z.string(),
  material:z.string(), sentExtent:z.tuple([z.number(),z.number().nullable()]),
  inferenceWindow:z.tuple([z.number(),z.number().nullable()]), bytes:z.int().nonnegative().optional(),
  utc:z.iso.datetime(), state:z.enum(["attempted","sent","unknown"]), result:z.enum(["complete","partial","failed"]),
  reason:z.string().optional(),
});
const cleanupCall = modelCall.extend({
  role:z.literal("cleanup"), engine:z.literal("twelvelabs"), model:z.null(), material:z.literal("none"),
  bytes:z.literal(0), copies:z.int().nonnegative(), sentExtent:z.null(), inferenceWindow:z.null(),
});
export const engineCall = z.union([modelCall,cleanupCall]);
export type CleanupCall = z.infer<typeof cleanupCall>;
export type EngineCall = z.infer<typeof engineCall>;
export const engineRunFields = {
  library:z.array(copyReceipt).optional(), engineCalls:z.array(engineCall).optional(),
  indexWait:z.strictObject({limitSeconds:z.int().positive(),elapsedMs:z.int().nonnegative()}).optional(),
};
