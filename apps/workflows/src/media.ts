import { z } from "zod";
import {
  MAX_MEDIA_BYTES,
  sha256Schema,
  supportedMediaMimeTypeSchema,
} from "../../../src/domain/studio-schemas.js";
import { opaqueIdSchema } from "../../../src/domain/studio-identifiers.js";

export const HOSTED_MEDIA_OPEN_SESSION_CAP_DEFAULT = 2;
export const HOSTED_MEDIA_MAX_BYTES_DEFAULT = MAX_MEDIA_BYTES;
export const HOSTED_MEDIA_SESSION_TTL_SECONDS_DEFAULT = 60 * 60;
export const HOSTED_MEDIA_MIN_PART_BYTES = 256 * 1_024;

export const hostedMediaCreateRequestSchema = z.object({
  declaredSizeBytes: z.number().int().min(1).max(MAX_MEDIA_BYTES),
  declaredSha256: sha256Schema,
  mimeType: supportedMediaMimeTypeSchema,
  durationSeconds: z.number().finite().positive().max(86_400),
  retention: z.enum(["ephemeral", "retained"]),
}).strict();

export type HostedMediaCreateRequest = z.infer<
  typeof hostedMediaCreateRequestSchema
>;

export const hostedMediaCreateResponseSchema = z.object({
  mediaId: opaqueIdSchema,
  uploadUrl: z.string().url().max(4_096),
  partBytes: z.number().int().min(HOSTED_MEDIA_MIN_PART_BYTES),
  sessionExpiresAt: z.string().datetime({ offset: false }),
}).strict();

export type HostedMediaCreateResponse = z.infer<
  typeof hostedMediaCreateResponseSchema
>;

export const hostedMediaUploadStateSchema = z.enum([
  "creating",
  "open",
  "sealing",
  "cleaning",
  "sealed",
  "abandoned",
  "cleanup_failed",
]);

export interface HostedMediaUploadSession {
  principalSub: string;
  mediaId: string;
  declaredSizeBytes: number;
  declaredSha256: string;
  mimeType: z.infer<typeof supportedMediaMimeTypeSchema>;
  durationSeconds: number;
  retention: "ephemeral" | "retained";
  uploadUrlCiphertext?: string;
  uploadUrlIv?: string;
  geminiFileName?: string;
  providerPartBytes?: number;
  state: z.infer<typeof hostedMediaUploadStateSchema>;
  createdAt: string;
  sessionExpiresAt: string;
  updatedAt: string;
}
