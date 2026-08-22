import { z } from "zod";
import {
  analysisContextSchema,
  idempotencyKeySchema,
  sha256Schema,
  supportedMediaMimeTypeSchema,
} from "../../../src/domain/studio-schemas.js";
import { opaqueIdSchema } from "../../../src/domain/studio-identifiers.js";
import { hostedSpendPlanSchema } from "./spend.js";

export const HOSTED_WORKFLOW_STEPS = [
  "fetch_context",
  "ensure_gemini_file",
  "transcribe",
  "index",
  "interrogate",
  "cleanup",
  "publish",
] as const;

export type HostedWorkflowStepName = (typeof HOSTED_WORKFLOW_STEPS)[number];

export const MODEL_REQUEST_TIMEOUT_MS = 10 * 60_000;
export const HOSTED_WORKFLOW_STEP_TIMEOUT_MS = 15 * 60_000;

interface HostedWorkflowStepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}

export const HOSTED_PROVIDER_STEP_CONFIG = {
  retries: {
    limit: 0,
    delay: "1 second",
    backoff: "constant",
  },
  timeout: "15 minutes",
} as const satisfies HostedWorkflowStepConfig;

export const HOSTED_STATE_STEP_CONFIG = {
  retries: {
    limit: 2,
    delay: "1 second",
    backoff: "exponential",
  },
  timeout: "15 minutes",
} as const satisfies HostedWorkflowStepConfig;

const utcDateTimeSchema = z.string().datetime({ offset: false });
const safeCodeSchema = z.string().min(1).max(120).regex(/^[a-z0-9_:-]+$/);
const workflowInstanceIdSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);

export const sealedHostedMediaReceiptSchema = z.object({
  principalSub: z.string().min(1).max(240),
  mediaId: opaqueIdSchema,
  geminiFileName: z.string().min(7).max(128).regex(/^files\/[a-zA-Z0-9_-]+$/),
  geminiFileUri: z.string().url().max(2_000),
  sha256: sha256Schema,
  mimeType: supportedMediaMimeTypeSchema,
  retention: z.enum(["ephemeral", "retained"]),
  durationSeconds: z.number().finite().positive().max(86_400),
  sealedAt: utcDateTimeSchema,
  expiresAt: utcDateTimeSchema,
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.sealedAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "sealed media expiry must follow its seal time",
    });
  }
});

export type SealedHostedMediaReceipt = z.infer<
  typeof sealedHostedMediaReceiptSchema
>;

export interface HostedMediaView {
  id: string;
  sha256: string;
  mimeType: SealedHostedMediaReceipt["mimeType"];
  retention: SealedHostedMediaReceipt["retention"];
  sealedAt: string;
  expiresAt: string;
}

export function hostedMediaView(
  receipt: SealedHostedMediaReceipt,
): HostedMediaView {
  return {
    id: receipt.mediaId,
    sha256: receipt.sha256,
    mimeType: receipt.mimeType,
    retention: receipt.retention,
    sealedAt: receipt.sealedAt,
    expiresAt: receipt.expiresAt,
  };
}

export const hostedJobCreateRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  mediaId: opaqueIdSchema,
  context: analysisContextSchema,
  recipeId: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9-]+$/),
  model: z.string().min(1).max(240).optional(),
  focus: z.string().max(10_000).optional(),
  transcriptOffsetSeconds: z.number().int().min(-31_536_000).max(31_536_000)
    .optional(),
}).strict();

export type HostedJobCreateRequest = z.infer<
  typeof hostedJobCreateRequestSchema
>;

export const hostedRetryRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
}).strict();

export interface HostedAttemptInput {
  mediaId: string;
  mediaSha256: string;
  context: z.infer<typeof analysisContextSchema>;
  recipe: {
    id: string;
    label: string;
    revision: string;
    sha256: string;
  };
  model: string;
  focus?: string;
  transcriptOffsetSeconds?: number;
  retention: "ephemeral" | "retained";
  spendPlan: z.infer<typeof hostedSpendPlanSchema>;
}

export const hostedAttemptInputSchema: z.ZodType<HostedAttemptInput> = z.object({
  mediaId: opaqueIdSchema,
  mediaSha256: sha256Schema,
  context: analysisContextSchema,
  recipe: z.object({
    id: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9-]+$/),
    label: z.string().min(1).max(100),
    revision: z.string().min(1).max(120),
    sha256: sha256Schema,
  }).strict(),
  model: z.string().min(1).max(240),
  focus: z.string().max(10_000).optional(),
  transcriptOffsetSeconds: z.number().int().min(-31_536_000).max(31_536_000)
    .optional(),
  retention: z.enum(["ephemeral", "retained"]),
  spendPlan: hostedSpendPlanSchema,
}).strict();

export const hostedAttemptSchema = z.object({
  principalSub: z.string().min(1).max(240),
  attemptId: opaqueIdSchema,
  jobId: opaqueIdSchema,
  retryOfAttemptId: opaqueIdSchema.optional(),
  attemptNumber: z.number().int().min(1).max(1_000),
  idempotencyKey: idempotencyKeySchema,
  workflowInstanceId: workflowInstanceIdSchema,
  input: hostedAttemptInputSchema,
  stage: z.enum([
    "queued",
    ...HOSTED_WORKFLOW_STEPS,
    "succeeded",
    "failed",
    "canceled",
    "indeterminate",
  ]),
  spendReservedUnits: z.number().int().min(1),
  cancellationRequestedAt: utcDateTimeSchema.optional(),
  runId: z.string().min(1).max(240).optional(),
  errorCode: safeCodeSchema.optional(),
  cleanupCompletedAt: utcDateTimeSchema.optional(),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
}).strict();

export type HostedAnalysisAttempt = z.infer<typeof hostedAttemptSchema>;

export interface HostedWorkflowParameters {
  principalSub: string;
  attemptId: string;
}

export const hostedWorkflowParametersSchema = z.object({
  principalSub: z.string().min(1).max(240),
  attemptId: opaqueIdSchema,
}).strict();

export interface HostedDispatchReceipt {
  attemptId: string;
  workflowInstanceId: string;
  replayed: boolean;
}

export interface HostedJobView {
  id: string;
  rootJobId: string;
  retryOfAttemptId?: string;
  attempt: number;
  stage: HostedAnalysisAttempt["stage"];
  runId?: string;
  errorCode?: string;
  cleanupCompleted: boolean;
  cancellationRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  receipt: {
    recipe: {
      id: string;
      label: string;
      revision: string;
    };
    context: {
      mode: "none" | "meeting";
      provider?: "bluedot" | "granola" | "file";
      transport?: "mcp" | "api" | "file";
    };
    model: string;
    retention: "ephemeral" | "retained";
  };
}

export function hostedJobView(attempt: HostedAnalysisAttempt): HostedJobView {
  return {
    id: attempt.attemptId,
    rootJobId: attempt.jobId,
    ...(attempt.retryOfAttemptId
      ? { retryOfAttemptId: attempt.retryOfAttemptId }
      : {}),
    attempt: attempt.attemptNumber,
    stage: attempt.stage,
    ...(attempt.runId ? { runId: attempt.runId } : {}),
    ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
    cleanupCompleted: Boolean(attempt.cleanupCompletedAt),
    ...(attempt.cancellationRequestedAt
      ? { cancellationRequestedAt: attempt.cancellationRequestedAt }
      : {}),
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    receipt: {
      recipe: {
        id: attempt.input.recipe.id,
        label: attempt.input.recipe.label,
        revision: attempt.input.recipe.revision,
      },
      context: "mode" in attempt.input.context
        ? { mode: "none" }
        : {
            mode: "meeting",
            provider: attempt.input.context.provider,
            transport: attempt.input.context.transport,
          },
      model: attempt.input.model,
      retention: attempt.input.retention,
    },
  };
}

export function isHostedAttemptTerminal(
  attempt: HostedAnalysisAttempt,
): boolean {
  return ["succeeded", "failed", "canceled", "indeterminate"]
    .includes(attempt.stage);
}

export function parseReceiptJson<T>(value: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(value));
}
