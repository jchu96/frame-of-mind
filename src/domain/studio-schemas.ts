import { z } from "zod";
import {
  ANALYSIS_JOB_STAGES,
  ANALYSIS_JOB_TERMINAL_STAGES,
  MEDIA_SESSION_STATES,
} from "./studio-types.js";
import { canTransitionAnalysisJob } from "./studio-state.js";
import { opaqueIdSchema } from "./studio-identifiers.js";

export const MAX_MEDIA_BYTES = 2 * 1_024 * 1_024 * 1_024;
export const MAX_MEDIA_PARTS = 512;
export const MAX_MEDIA_PART_BYTES = 64 * 1_024 * 1_024;
export const DEFAULT_MEDIA_PART_SIZE_BYTES = 8 * 1_024 * 1_024;
export const MAX_RETAINED_MEDIA_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_CONTEXT_FILE_BYTES = 8 * 1_024 * 1_024;

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const utcDateTimeSchema = z.string().datetime({ offset: false });
export const idempotencyKeySchema = z.string()
  .min(8)
  .max(200)
  .regex(/^[a-zA-Z0-9._:-]+$/, "idempotency key contains unsafe characters");
const safeMessageSchema = z.string()
  .min(1)
  .max(2_000)
  .refine(
    (value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
    "message contains control characters",
  );
export const publishedRunIdSchema = z.string().min(1).max(240)
  .regex(/^[a-zA-Z0-9._:-]+$/);

export const analysisJobExecutionResultSchema = z.object({
  runId: publishedRunIdSchema,
  projectionWarning: safeMessageSchema.optional(),
}).strict();

export const analysisJobStageSchema = z.enum(ANALYSIS_JOB_STAGES);
export const analysisJobTerminalStageSchema = z.enum(
  ANALYSIS_JOB_TERMINAL_STAGES,
);
export const mediaSessionStateSchema = z.enum(MEDIA_SESSION_STATES);

const retainedMediaSchema = z.object({
  mode: z.literal("retained"),
  expiresAt: utcDateTimeSchema,
}).strict();

export const mediaRetentionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("ephemeral"),
    expiresAt: utcDateTimeSchema,
  }).strict(),
  retainedMediaSchema,
]);

export const mediaRetentionRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("ephemeral") }).strict(),
  z.object({
    mode: z.literal("retained"),
    ttlSeconds: z.number().int().min(60 * 60).max(MAX_RETAINED_MEDIA_TTL_SECONDS),
  }).strict(),
]);

export const supportedMediaMimeTypeSchema = z.enum([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export const contextFileFormatSchema = z.enum([
  "json",
  "text",
  "markdown",
  "srt",
  "vtt",
]);
export type ContextFileFormat = z.infer<typeof contextFileFormatSchema>;

export const contextFileReceiptSchema = z.object({
  id: opaqueIdSchema,
  format: contextFileFormatSchema,
  bytes: z.number().int().min(1).max(MAX_CONTEXT_FILE_BYTES),
  sha256: sha256Schema,
  expiresAt: utcDateTimeSchema,
}).strict();

export const mediaCreateRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  expectedBytes: z.number().int().min(1).max(MAX_MEDIA_BYTES),
  mimeType: supportedMediaMimeTypeSchema,
  fileFingerprintSha256: sha256Schema.optional(),
  retention: mediaRetentionRequestSchema,
}).strict();

export const mediaCompleteRequestSchema = z.object({
  expectedSha256: sha256Schema.optional(),
}).strict();

export const providerContextSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("bluedot"),
    transport: z.literal("mcp"),
    meetingId: z.string().min(1).max(500),
  }).strict(),
  z.object({
    provider: z.literal("granola"),
    transport: z.enum(["mcp", "api"]),
    meetingId: z.string().min(1).max(500),
  }).strict(),
  z.object({
    provider: z.literal("file"),
    transport: z.literal("file"),
    contextFileId: opaqueIdSchema,
    contextFileSha256: sha256Schema,
  }).strict(),
]);

export const videoOnlyContextSchema = z.object({
  mode: z.literal("none"),
}).strict();

export const analysisContextSchema = z.union([
  providerContextSchema,
  videoOnlyContextSchema,
]);

export const transcriptOffsetSecondsSchema = z.number()
  .int()
  .min(-31_536_000)
  .max(31_536_000);

const recipeIdSchema = z.string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]+$/);

// Deliberately instruction-only: Studio rejects every custom recipe before
// queue insertion (custom_recipe_staging_unavailable), so ADR 0016 charter
// support here waits for the custom-recipe staging contract rather than
// accepting a shape the executor cannot run yet.
export const customRecipeSchema = z.object({
  id: recipeIdSchema,
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  indexInstruction: z.string().min(1).max(8_000),
  interrogationInstruction: z.string().min(1).max(8_000),
  revision: z.string().min(1).max(120).optional(),
}).strict();

export const composerRecipeSchema = z.union([
  z.object({
    id: recipeIdSchema,
    revision: z.string().min(1).max(120),
  }).strict(),
  z.object({ custom: customRecipeSchema }).strict(),
]);

const immutableJobInputBaseSchema = z.object({
  mediaSessionId: opaqueIdSchema,
  mediaSha256: sha256Schema,
  context: analysisContextSchema,
  recipe: z.object({
    id: recipeIdSchema,
    // Optional only for compatibility with pre-executor local rows. New job
    // creation must persist the composer-resolved provenance explicitly.
    custom: z.boolean().optional(),
    revision: z.string().min(1).max(120),
    sha256: sha256Schema,
  }).strict(),
  model: z.string().min(1).max(240),
  focus: z.string().max(10_000).optional(),
  transcriptOffsetSeconds: transcriptOffsetSecondsSchema.optional(),
  retention: mediaRetentionSchema,
}).strict();

function rejectVideoOnlyTranscriptOffset(
  input: z.infer<typeof immutableJobInputBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (
    "mode" in input.context
    && input.context.mode === "none"
    && input.transcriptOffsetSeconds !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["transcriptOffsetSeconds"],
      message: "video-only input cannot include transcript alignment",
    });
  }
}

export const immutableJobInputSchema = immutableJobInputBaseSchema.superRefine(
  rejectVideoOnlyTranscriptOffset,
);

const newImmutableJobInputSchema = immutableJobInputBaseSchema.extend({
  recipe: z.object({
    id: recipeIdSchema,
    custom: z.boolean(),
    revision: z.string().min(1).max(120),
    sha256: sha256Schema,
  }).strict(),
}).strict().superRefine(rejectVideoOnlyTranscriptOffset);

export type ImmutableJobInput = z.infer<typeof immutableJobInputSchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function canonicalImmutableJobInputJson(
  input: ImmutableJobInput,
): string {
  return canonicalJson(input);
}

export async function digestImmutableJobInput(
  input: ImmutableJobInput,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalImmutableJobInputJson(input),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const verifiedImmutableJobInputBrand: unique symbol = Symbol(
  "verifiedImmutableJobInput",
);

export interface VerifiedImmutableJobInput {
  input: ImmutableJobInput;
  inputDigest: string;
  readonly [verifiedImmutableJobInputBrand]: true;
}

export async function verifyImmutableJobInput(
  input: unknown,
): Promise<VerifiedImmutableJobInput> {
  const parsed = immutableJobInputSchema.parse(input);
  return {
    input: parsed,
    inputDigest: await digestImmutableJobInput(parsed),
    [verifiedImmutableJobInputBrand]: true,
  };
}

export const analysisJobSchema = z.object({
  id: opaqueIdSchema,
  rootJobId: opaqueIdSchema,
  retryOfJobId: opaqueIdSchema.optional(),
  attempt: z.number().int().min(1).max(1_000),
  idempotencyKey: idempotencyKeySchema,
  inputDigest: sha256Schema,
  stage: analysisJobStageSchema,
  cancellationRequestedAt: utcDateTimeSchema.optional(),
  input: immutableJobInputSchema,
  terminal: z.object({
    outcome: analysisJobTerminalStageSchema,
    at: utcDateTimeSchema,
    code: z.string().min(1).max(120).regex(/^[a-z0-9_:-]+$/).optional(),
    message: safeMessageSchema.optional(),
  }).strict().optional(),
  runId: publishedRunIdSchema.optional(),
  projectionWarning: safeMessageSchema.optional(),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
}).strict().superRefine((job, context) => {
  if (job.attempt === 1) {
    if (job.retryOfJobId) {
      context.addIssue({
        code: "custom",
        path: ["retryOfJobId"],
        message: "an initial attempt cannot identify a retry parent",
      });
    }
    if (job.rootJobId !== job.id) {
      context.addIssue({
        code: "custom",
        path: ["rootJobId"],
        message: "an initial attempt must be its own root job",
      });
    }
  } else {
    if (!job.retryOfJobId) {
      context.addIssue({
        code: "custom",
        path: ["retryOfJobId"],
        message: "a retry attempt must identify its parent job",
      });
    }
    if (job.rootJobId === job.id || job.retryOfJobId === job.id) {
      context.addIssue({
        code: "custom",
        path: ["rootJobId"],
        message: "a retry attempt cannot be its own root or parent",
      });
    }
  }

  const terminal = ANALYSIS_JOB_TERMINAL_STAGES.includes(job.stage as never);
  if (terminal && job.terminal?.outcome !== job.stage) {
    context.addIssue({
      code: "custom",
      path: ["terminal", "outcome"],
      message: "terminal metadata must match the job stage",
    });
  }
  if (!terminal && job.terminal) {
    context.addIssue({
      code: "custom",
      path: ["terminal"],
      message: "a nonterminal job cannot have terminal metadata",
    });
  }
  if (job.stage === "succeeded" && !job.runId) {
    context.addIssue({
      code: "custom",
      path: ["runId"],
      message: "a succeeded job must identify its published run",
    });
  }
  if (
    job.runId
    && job.stage !== "cleaning_up"
    && job.stage !== "succeeded"
  ) {
    context.addIssue({
      code: "custom",
      path: ["runId"],
      message: "only a publishing or succeeded job may identify a durable run",
    });
  }
  if (
    job.projectionWarning
    && job.stage !== "cleaning_up"
    && job.stage !== "succeeded"
  ) {
    context.addIssue({
      code: "custom",
      path: ["projectionWarning"],
      message: "only a published run may carry a projection warning",
    });
  }
  if (job.projectionWarning && !job.runId) {
    context.addIssue({
      code: "custom",
      path: ["projectionWarning"],
      message: "a projection warning requires a published run",
    });
  }
  if (Date.parse(job.updatedAt) < Date.parse(job.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "updatedAt must not precede createdAt",
    });
  }
  if (
    job.terminal
    && (
      Date.parse(job.terminal.at) < Date.parse(job.createdAt)
      || Date.parse(job.terminal.at) > Date.parse(job.updatedAt)
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["terminal", "at"],
      message: "terminal time must fall within the job lifetime",
    });
  }
  if (
    job.cancellationRequestedAt
    && (
      Date.parse(job.cancellationRequestedAt) < Date.parse(job.createdAt)
      || Date.parse(job.cancellationRequestedAt) > Date.parse(job.updatedAt)
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["cancellationRequestedAt"],
      message: "cancellation request time must fall within the job lifetime",
    });
  }
  if (
    job.input.retention.mode === "retained"
    && (
      Date.parse(job.input.retention.expiresAt) <= Date.parse(job.createdAt)
      || Date.parse(job.input.retention.expiresAt)
        > Date.parse(job.createdAt) + MAX_RETAINED_MEDIA_TTL_SECONDS * 1_000
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["input", "retention", "expiresAt"],
      message: "retained job input must use the bounded server-owned lifetime",
    });
  }
});

export async function validateAnalysisJob(input: unknown) {
  const job = analysisJobSchema.parse(input);
  if (job.inputDigest !== await digestImmutableJobInput(job.input)) {
    throw new Error(
      "inputDigest must be the canonical SHA-256 of immutable input.",
    );
  }
  return job;
}

const analysisJobEventBaseSchema = z.object({
  jobId: opaqueIdSchema,
  attempt: z.number().int().min(1).max(1_000),
  sequence: z.number().int().min(1),
  stage: analysisJobStageSchema,
  occurredAt: utcDateTimeSchema,
});

const progressMetadataSchema = z.object({
  completed: z.number().finite().nonnegative(),
  total: z.number().finite().positive(),
  unit: z.enum(["bytes", "items", "steps"]),
}).strict().superRefine((progress, context) => {
  if (progress.completed > progress.total) {
    context.addIssue({
      code: "custom",
      path: ["completed"],
      message: "completed progress must not exceed total",
    });
  }
});

const transitionEventSchema = analysisJobEventBaseSchema.extend({
  kind: z.literal("transition"),
  previousStage: analysisJobStageSchema,
  message: safeMessageSchema,
}).strict().superRefine((event, context) => {
  if (!canTransitionAnalysisJob(event.previousStage, event.stage)) {
    context.addIssue({
      code: "custom",
      path: ["stage"],
      message: `forbidden analysis-job transition: ${event.previousStage} -> ${event.stage}`,
    });
  }
});

export const analysisJobEventSchema = z.discriminatedUnion("kind", [
  transitionEventSchema,
  analysisJobEventBaseSchema.extend({
    kind: z.literal("progress"),
    progress: progressMetadataSchema,
    message: safeMessageSchema.optional(),
  }).strict(),
  analysisJobEventBaseSchema.extend({
    kind: z.literal("cancellation_requested"),
    message: safeMessageSchema,
  }).strict(),
  analysisJobEventBaseSchema.extend({
    kind: z.literal("warning"),
    code: z.string().min(1).max(120).regex(/^[a-z0-9_:-]+$/).optional(),
    message: safeMessageSchema,
  }).strict(),
  analysisJobEventBaseSchema.extend({
    kind: z.literal("cleanup"),
    message: safeMessageSchema,
  }).strict(),
]);

export const mediaPartReceiptSchema = z.object({
  part: z.number().int().nonnegative().max(MAX_MEDIA_PARTS - 1),
  offset: z.number().int().nonnegative().max(MAX_MEDIA_BYTES - 1),
  bytes: z.number().int().positive().max(MAX_MEDIA_PART_BYTES),
  sha256: sha256Schema,
  receivedAt: utcDateTimeSchema,
}).strict();

export const mediaSessionSchema = z.object({
  id: opaqueIdSchema,
  status: mediaSessionStateSchema,
  expectedBytes: z.number().int().min(1).max(MAX_MEDIA_BYTES),
  receivedBytes: z.number().int().nonnegative().max(MAX_MEDIA_BYTES),
  partSizeBytes: z.number().int().positive().max(MAX_MEDIA_PART_BYTES),
  parts: z.array(mediaPartReceiptSchema).max(MAX_MEDIA_PARTS),
  mimeType: supportedMediaMimeTypeSchema,
  fileFingerprintSha256: sha256Schema.optional(),
  sha256: sha256Schema.optional(),
  retention: mediaRetentionSchema,
  uploadExpiresAt: utcDateTimeSchema.optional(),
  cleanupFailureCode: z.string().min(1).max(120)
    .regex(/^[a-z0-9_:-]+$/)
    .optional(),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
}).strict().superRefine((media, context) => {
  if (media.receivedBytes > media.expectedBytes) {
    context.addIssue({
      code: "custom",
      path: ["receivedBytes"],
      message: "received bytes must not exceed expected bytes",
    });
  }
  const expectedPartCount = Math.ceil(
    media.expectedBytes / media.partSizeBytes,
  );
  if (expectedPartCount > MAX_MEDIA_PARTS) {
    context.addIssue({
      code: "custom",
      path: ["partSizeBytes"],
      message: "media part size would exceed the maximum part count",
    });
  }
  let receiptBytes = 0;
  media.parts.forEach((part, index) => {
    const expectedOffset = index * media.partSizeBytes;
    const expectedBytes = Math.min(
      media.partSizeBytes,
      media.expectedBytes - expectedOffset,
    );
    if (
      part.part !== index
      || part.offset !== expectedOffset
      || part.bytes !== expectedBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["parts", index],
        message: "media part receipts must be contiguous and exact",
      });
    }
    receiptBytes += part.bytes;
    if (
      Date.parse(part.receivedAt) < Date.parse(media.createdAt)
      || Date.parse(part.receivedAt) > Date.parse(media.updatedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["parts", index, "receivedAt"],
        message: "media part time must fall within the session lifetime",
      });
    }
  });
  if (receiptBytes !== media.receivedBytes) {
    context.addIssue({
      code: "custom",
      path: ["receivedBytes"],
      message: "received bytes must equal the durable part receipts",
    });
  }
  if (
    media.status === "created"
    && (media.receivedBytes !== 0 || media.parts.length !== 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "created media cannot claim uploaded parts",
    });
  }
  if (
    ["sealed", "in_use", "retained"].includes(media.status)
    && (!media.sha256 || media.receivedBytes !== media.expectedBytes)
  ) {
    context.addIssue({
      code: "custom",
      path: ["sha256"],
      message: "sealed media requires complete bytes and a digest",
    });
  }
  if (media.status === "retained" && media.retention.mode !== "retained") {
    context.addIssue({
      code: "custom",
      path: ["retention", "mode"],
      message: "retained media requires an explicit retained receipt",
    });
  }
  if (
    Date.parse(media.retention.expiresAt) <= Date.parse(media.createdAt)
    || Date.parse(media.retention.expiresAt)
      > Date.parse(media.createdAt) + MAX_RETAINED_MEDIA_TTL_SECONDS * 1_000
  ) {
    context.addIssue({
      code: "custom",
      path: ["retention", "expiresAt"],
      message: "media must use the bounded server-owned lifetime",
    });
  }
  if (
    ["created", "uploading"].includes(media.status)
    && (
      !media.uploadExpiresAt
      || Date.parse(media.uploadExpiresAt) <= Date.parse(media.createdAt)
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["uploadExpiresAt"],
      message: "an unfinished upload requires a future expiry",
    });
  }
  if (
    !["created", "uploading"].includes(media.status)
    && media.uploadExpiresAt
  ) {
    context.addIssue({
      code: "custom",
      path: ["uploadExpiresAt"],
      message: "only unfinished uploads carry an upload expiry",
    });
  }
  if (
    (media.status === "cleanup_failed") !== Boolean(media.cleanupFailureCode)
  ) {
    context.addIssue({
      code: "custom",
      path: ["cleanupFailureCode"],
      message: "cleanup failure state and code must agree",
    });
  }
  if (Date.parse(media.updatedAt) < Date.parse(media.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "updatedAt must not precede createdAt",
    });
  }
});

const configurationProviderStatusSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("gemini"),
    connected: z.boolean(),
    source: z.enum(["environment", "session", "none"]),
    lifetime: z.enum(["process", "none"]),
    lastVerifiedAt: utcDateTimeSchema.optional(),
    failureCode: z.string().min(1).max(120)
      .regex(/^[a-z0-9_:-]+$/)
      .optional(),
  }).strict(),
  z.object({
    provider: z.literal("bluedot"),
    connected: z.boolean(),
    source: z.enum(["oauth", "none"]),
    lifetime: z.enum(["persistent-oauth", "none"]),
    lastVerifiedAt: utcDateTimeSchema.optional(),
    failureCode: z.string().min(1).max(120)
      .regex(/^[a-z0-9_:-]+$/)
      .optional(),
  }).strict(),
  z.object({
    provider: z.literal("granola"),
    connected: z.boolean(),
    source: z.enum(["environment", "session", "oauth", "none"]),
    lifetime: z.enum(["process", "persistent-oauth", "none"]),
    lastVerifiedAt: utcDateTimeSchema.optional(),
    failureCode: z.string().min(1).max(120)
      .regex(/^[a-z0-9_:-]+$/)
      .optional(),
  }).strict(),
]);

export const configurationStatusSchema = z.object({
  studioEnabled: z.boolean(),
  providers: z.array(configurationProviderStatusSchema).max(3),
}).strict().superRefine((status, context) => {
  const seen = new Set<string>();
  status.providers.forEach((provider, index) => {
    if (seen.has(provider.provider)) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "provider"],
        message: "provider status entries must be unique",
      });
    }
    seen.add(provider.provider);
    const expectedLifetime = provider.source === "oauth"
      ? "persistent-oauth"
      : provider.source === "none"
        ? "none"
        : "process";
    if (provider.lifetime !== expectedLifetime) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "lifetime"],
        message: "credential lifetime must agree with its source",
      });
    }
    if (provider.connected && provider.source === "none") {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "connected"],
        message: "a connected provider must identify a credential source",
      });
    }
  });
});

export const meetingCatalogItemSchema = z.object({
  id: z.string().min(1).max(500),
  title: z.string().min(1).max(500).optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export const meetingCatalogPageSchema = z.object({
  items: z.array(meetingCatalogItemSchema).max(16),
  nextCursor: z.string().min(1).max(200).optional(),
}).strict();

export const meetingCatalogRequestSchema = z.object({
  provider: z.enum(["bluedot", "granola"]),
  transport: z.enum(["mcp", "api"]),
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(200)
    .regex(/^[a-zA-Z0-9._~:-]+$/)
    .optional(),
  limit: z.number().int().min(1).max(16),
}).strict().superRefine((value, context) => {
  if (value.provider === "bluedot" && value.transport !== "mcp") {
    context.addIssue({
      code: "custom",
      path: ["transport"],
      message: "Bluedot catalog transport must be MCP",
    });
  }
});

export const composerPayloadSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  mediaSessionId: opaqueIdSchema,
  context: analysisContextSchema,
  recipe: composerRecipeSchema,
  model: z.string().min(1).max(240),
  focus: z.string().max(10_000).optional(),
  transcriptOffsetSeconds: transcriptOffsetSecondsSchema.optional(),
  retention: mediaRetentionRequestSchema,
}).strict().superRefine((input, context) => {
  if (
    "mode" in input.context
    && input.context.mode === "none"
    && input.transcriptOffsetSeconds !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["transcriptOffsetSeconds"],
      message: "video-only input cannot include transcript alignment",
    });
  }
});

export const jobCreateRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  input: newImmutableJobInputSchema,
}).strict();

export const jobRetryRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const jobCancelRequestSchema = z.object({}).strict();

export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export type AnalysisJobEvent = z.infer<typeof analysisJobEventSchema>;
export type MediaSession = z.infer<typeof mediaSessionSchema>;
export type MediaPartReceipt = z.infer<typeof mediaPartReceiptSchema>;
export type MediaCreateRequest = z.infer<typeof mediaCreateRequestSchema>;
export type MediaCompleteRequest = z.infer<typeof mediaCompleteRequestSchema>;
export type MediaRetentionRequest = z.infer<typeof mediaRetentionRequestSchema>;
export type ConfigurationStatus = z.infer<typeof configurationStatusSchema>;
export type ComposerPayload = z.infer<typeof composerPayloadSchema>;
export type JobCreateRequest = z.infer<typeof jobCreateRequestSchema>;
export type JobRetryRequest = z.infer<typeof jobRetryRequestSchema>;
