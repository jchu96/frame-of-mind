import { z } from "zod";
import { runIdSchema, timestampSchema } from "./schemas.js";
import { timestampToSeconds } from "../lib/time.js";

export const candidateFailureCodeSchema = z.enum([
  "response_missing",
  "invalid_json",
  "schema_validation",
  "evidence_out_of_range",
  "generation_failed",
]);

export const candidateValidationIssueSchema = z.strictObject({
  path: z.string().min(1).max(520).regex(/^[a-zA-Z0-9_.-]+$/),
  code: z.string().min(1).max(64).regex(/^[a-z_]+$/),
});

export const candidateFailureSchema = z.strictObject({
  candidateOrdinal: z.number().int().min(1).max(1_000),
  start: timestampSchema,
  end: timestampSchema,
  code: candidateFailureCodeSchema,
  attempts: z.union([z.literal(1), z.literal(2)]),
  issues: z.array(candidateValidationIssueSchema).max(3).optional(),
}).superRefine((value, context) => {
  if (timestampToSeconds(value.end) <= timestampToSeconds(value.start)) {
    context.addIssue({
      code: "custom",
      path: ["end"],
      message: "candidate failure end timestamp must be after start",
    });
  }
  if (value.code !== "schema_validation" && value.issues?.length) {
    context.addIssue({
      code: "custom",
      path: ["issues"],
      message: "only schema validation failures may include issue paths",
    });
  }
});

export const analysisOutcomeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  status: z.enum(["complete", "partial", "failed"]),
  candidates: z.strictObject({
    indexed: z.number().int().min(0).max(1_000),
    selected: z.number().int().min(0).max(1_000),
    omittedByLimit: z.number().int().min(0).max(1_000),
    validated: z.number().int().min(0).max(1_000),
    accepted: z.number().int().min(0).max(1_000),
    rejected: z.number().int().min(0).max(1_000),
    failed: z.number().int().min(0).max(1_000),
  }),
  failures: z.array(candidateFailureSchema).max(1_000),
}).superRefine((value, context) => {
  if (value.candidates.selected + value.candidates.omittedByLimit !== value.candidates.indexed) {
    context.addIssue({
      code: "custom",
      path: ["candidates"],
      message: "indexed candidate totals must balance",
    });
  }
  if (value.candidates.validated + value.candidates.failed !== value.candidates.selected) {
    context.addIssue({
      code: "custom",
      path: ["candidates"],
      message: "selected candidate totals must balance",
    });
  }
  if (value.candidates.accepted + value.candidates.rejected !== value.candidates.validated) {
    context.addIssue({
      code: "custom",
      path: ["candidates"],
      message: "validated candidate totals must balance",
    });
  }
  if (value.failures.length !== value.candidates.failed) {
    context.addIssue({
      code: "custom",
      path: ["failures"],
      message: "failure records must match the failed candidate count",
    });
  }
  const ordinals = new Set<number>();
  for (const [index, failure] of value.failures.entries()) {
    if (failure.candidateOrdinal > value.candidates.selected) {
      context.addIssue({
        code: "custom",
        path: ["failures", index, "candidateOrdinal"],
        message: "candidate ordinal must refer to a selected candidate",
      });
    }
    if (ordinals.has(failure.candidateOrdinal)) {
      context.addIssue({
        code: "custom",
        path: ["failures", index, "candidateOrdinal"],
        message: "candidate failure ordinals must be unique",
      });
    }
    ordinals.add(failure.candidateOrdinal);
  }
  const expectedStatus = value.candidates.failed === 0
    ? "complete"
    : value.candidates.validated === 0
      ? "failed"
      : "partial";
  if (value.status !== expectedStatus) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "status must agree with candidate counts",
    });
  }
});

export type CandidateFailureCode = z.infer<typeof candidateFailureCodeSchema>;
export type CandidateValidationIssue = z.infer<typeof candidateValidationIssueSchema>;
export type CandidateFailure = z.infer<typeof candidateFailureSchema>;
export type AnalysisOutcome = z.infer<typeof analysisOutcomeSchema>;

interface CandidateAnalysisErrorInput {
  code: CandidateFailureCode;
  attempts: 1 | 2;
  issues?: CandidateValidationIssue[];
  cause?: unknown;
}

/**
 * A sanitized, expected failure at the untrusted model-response boundary.
 * Only this error class may be isolated per candidate by the orchestrator.
 */
export class CandidateAnalysisError extends Error {
  override readonly name: string = "CandidateAnalysisError";
  readonly code: CandidateFailureCode;
  readonly attempts: 1 | 2;
  readonly issues: readonly CandidateValidationIssue[];

  constructor(
    input: CandidateAnalysisErrorInput,
    label = "Gemini analysis response",
  ) {
    const issues = input.issues
      ? candidateValidationIssueSchema.array().max(3).parse(input.issues)
      : [];
    super(candidateErrorMessage(label, input.code, issues));
    this.code = candidateFailureCodeSchema.parse(input.code);
    this.attempts = input.attempts;
    this.issues = issues;
    if (input.cause !== undefined) this.cause = input.cause;
  }

  withAttempts(attempts: 1 | 2): CandidateAnalysisError {
    return new CandidateAnalysisError({
      code: this.code,
      attempts,
      ...(this.issues.length ? { issues: [...this.issues] } : {}),
      cause: this,
    });
  }
}

function candidateErrorMessage(
  label: string,
  code: CandidateFailureCode,
  issues: readonly CandidateValidationIssue[],
): string {
  if (code === "schema_validation") {
    const locations = issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
    return `${label} failed strict local validation${locations ? ` at ${locations}` : ""}.`;
  }
  if (code === "invalid_json") return `${label} was not valid JSON.`;
  if (code === "response_missing") return `${label} is missing.`;
  if (code === "evidence_out_of_range") {
    return "Gemini returned an evidence timestamp outside the indexed candidate window.";
  }
  if (code === "generation_failed") {
    return "Gemini generation for this candidate failed after bounded transport retries.";
  }
  return "Gemini analysis response could not be validated.";
}
