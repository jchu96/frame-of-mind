import { z } from "zod";
import { runIdSchema } from "./schemas.js";
import {
  candidateFailureCodeSchema,
  candidateValidationIssueSchema,
} from "./analysis-outcome.js";

const utcDateTimeSchema = z.string().datetime({ offset: false });

export const analysisFailurePhaseSchema = z.enum([
  "upload",
  "index",
  "detail",
  "render",
  "cleanup",
]);

const analysisFailureCodeSchema = z.union([
  candidateFailureCodeSchema,
  z.literal("unexpected_failure"),
]);

const failureErrorSchema = z.strictObject({
  code: analysisFailureCodeSchema,
  attempts: z.union([z.literal(1), z.literal(2)]).optional(),
  issues: z.array(candidateValidationIssueSchema).max(3).optional(),
}).superRefine((value, context) => {
  if (candidateFailureCodeSchema.safeParse(value.code).success && value.attempts === undefined) {
    context.addIssue({
      code: "custom",
      path: ["attempts"],
      message: "candidate response failures must record bounded attempts",
    });
  }
  if (value.code === "unexpected_failure" && (value.attempts || value.issues)) {
    context.addIssue({
      code: "custom",
      path: ["code"],
      message: "unexpected failures cannot include provider response diagnostics",
    });
  }
});

export const runFailureManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  toolVersion: z.string().min(1).max(120),
  runId: runIdSchema,
  status: z.literal("failed"),
  phase: analysisFailurePhaseSchema,
  startedAt: utcDateTimeSchema,
  failedAt: utcDateTimeSchema,
  recipe: z.strictObject({
    id: z.string().min(1).max(120),
    revision: z.string().min(1).max(120),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  model: z.string().min(1).max(240),
  recordingSha256: z.string().regex(/^[a-f0-9]{64}$/),
  error: failureErrorSchema,
  remoteFile: z.strictObject({
    name: z.string().regex(/^files\/[A-Za-z0-9_-]+$/).max(1_000).optional(),
    expirationTime: utcDateTimeSchema.max(120).optional(),
    cleanup: z.enum([
      "not_obtained",
      "confirmed_deleted",
      "intentionally_retained",
      "unconfirmed",
    ]),
  }).superRefine((value, context) => {
    if (["confirmed_deleted", "intentionally_retained"].includes(value.cleanup) && !value.name) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "confirmed or retained cleanup requires an exact remote file name",
      });
    }
    if (value.cleanup === "not_obtained" && value.name) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "a not-obtained upload cannot identify a remote file",
      });
    }
  }),
}).superRefine((value, context) => {
  if (Date.parse(value.failedAt) < Date.parse(value.startedAt)) {
    context.addIssue({
      code: "custom",
      path: ["failedAt"],
      message: "failedAt must not be before startedAt",
    });
  }
});

export type AnalysisFailurePhase = z.infer<typeof analysisFailurePhaseSchema>;
export type RunFailureManifest = z.infer<typeof runFailureManifestSchema>;
