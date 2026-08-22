import { z } from "zod";
import { isSafeTelemetryCode } from "../../../src/lib/telemetry-code.js";

export const hostedTelemetryAreaSchema = z.enum([
  "access",
  "upload",
  "workflow",
  "spend",
  "publication",
  "cleanup",
]);

export const hostedTelemetryOutcomeSchema = z.enum([
  "started",
  "succeeded",
  "failed",
  "timeout",
  "canceled",
]);

const structuralString = z.string().min(1).max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const safeCode = z.string().min(1).max(120).refine(isSafeTelemetryCode);

export const hostedTelemetryEventSchema = z.object({
  area: hostedTelemetryAreaSchema,
  outcome: hostedTelemetryOutcomeSchema,
  code: safeCode,
  stage: structuralString.optional(),
  jobId: structuralString.optional(),
  recipeId: structuralString.optional(),
  recipeRevision: structuralString.optional(),
  model: structuralString.optional(),
  durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  routeClass: structuralString.optional(),
  status: z.number().int().min(100).max(599).optional(),
  byteCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  studioMode: z.literal("hosted").default("hosted"),
  version: structuralString.optional(),
}).strict();

export type HostedTelemetryEvent = z.infer<typeof hostedTelemetryEventSchema>;
export type HostedTelemetryOutcome = z.infer<typeof hostedTelemetryOutcomeSchema>;

export interface HostedTelemetryPort {
  readonly enabled: boolean;
  emit(event: HostedTelemetryEvent): Promise<void>;
}
