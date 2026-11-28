import { engineReason } from "./engine-plan.js";
import { actorSchema, candidateSchema, type Actor, type Candidate } from "./candidates.js";
import { proposalEdgesSchema, type ProposalEdges } from "./proposal-edges.js";
import { exactSpanSchema, humanTime } from "./source-bound.js";
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

const failureFields = {
  candidateOrdinal: z.number().int().min(1).max(1_000),
  start: timestampSchema,
  end: timestampSchema,
  code: candidateFailureCodeSchema,
  attempts: z.union([z.literal(1), z.literal(2)]),
  issues: z.array(candidateValidationIssueSchema).max(3).optional(),
} as const;
const legacyFailure = z.strictObject(failureFields).refine(v => timestampToSeconds(v.end) > timestampToSeconds(v.start),
  {message:"candidate failure end timestamp must be after start",path:["end"]});
const exactFailure = z.strictObject({...failureFields, attempts:z.union([z.literal(0),z.literal(1),z.literal(2)]),
  reason:engineReason.optional(), exactSpan:exactSpanSchema,
  candidateId:z.string().min(1).optional(), proposedBy:actorSchema.optional(), gradedBy:actorSchema.nullable().optional(),
  proposal:candidateSchema.optional(), proposalEdges:proposalEdgesSchema.optional()}).refine(
  v => v.start === humanTime(v.exactSpan.start) && v.end === humanTime(v.exactSpan.endExclusive),
  {message:"Failure labels must match their exact bounds.", path:["exactSpan"]});
function checkIssues(value: Pick<z.infer<typeof legacyFailure>,"issues"|"code">, context: z.RefinementCtx) {
  if (value.code !== "schema_validation" && value.issues?.length) {
    context.addIssue({
      code: "custom",
      path: ["issues"],
      message: "only schema validation failures may include issue paths",
    });
  }
}
export const candidateFailureSchema = legacyFailure.superRefine(checkIssues);
const exactFailureSchema = exactFailure.superRefine(checkIssues).refine(f=>f.attempts !== 0 || (f.gradedBy === null && !!f.reason),"An unattempted failure requires a reason and no grader.");
const outcomeBase = z.strictObject({
  runId: runIdSchema,
  status: z.enum(["complete", "partial", "failed"]),
  candidates: z.strictObject({
    indexed: z.number().int().min(0).max(1_000),
    selected: z.number().int().min(0).max(1_000),
    omittedByLimit: z.number().int().min(0).max(1_000),
    outOfRange: z.number().int().min(0).max(1_000).optional(),
    validated: z.number().int().min(0).max(1_000),
    accepted: z.number().int().min(0).max(1_000),
    rejected: z.number().int().min(0).max(1_000),
    failed: z.number().int().min(0).max(1_000),
  }),
});
const outcome1 = outcomeBase.extend({schemaVersion:z.literal(1), failures:z.array(candidateFailureSchema).max(1000)});
// A file can supply more rows than the 1,000 grading slots. These three
// counters describe its input array, whose maximum length in JS is 2^32 - 1.
const inputRowCount = z.int().min(0).max(2 ** 32 - 1);
const outcome2 = outcomeBase.extend({schemaVersion:z.literal(2), proposalIncomplete:z.literal(true).optional(), candidates:outcomeBase.shape.candidates.extend({
  indexed:inputRowCount, omittedByLimit:inputRowCount, outOfRange:inputRowCount.optional(),
}), failures:z.array(exactFailureSchema).max(1000)});
export const analysisOutcomeSchema = z.discriminatedUnion("schemaVersion", [outcome1, outcome2]).superRefine((value, context) => {
  if (value.candidates.selected + value.candidates.omittedByLimit + (value.candidates.outOfRange ?? 0) !== value.candidates.indexed) {
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
  // "complete" is a coverage claim, not just a validation claim: a run that
  // silently dropped indexed candidates to the moment limit must not report
  // itself complete (that lie cost a real episode its back half, 2026-08-24).
  const expectedStatus = value.candidates.failed > 0 && value.candidates.validated === 0
    ? "failed"
    : value.candidates.failed > 0 || value.candidates.omittedByLimit > 0 || (value.schemaVersion === 2 && value.proposalIncomplete)
      ? "partial"
      : "complete";
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
export type CandidateFailure = Omit<z.infer<typeof candidateFailureSchema>,"attempts"> & {attempts:0|1|2;reason?:z.infer<typeof engineReason>;exactSpan?: z.infer<typeof exactSpanSchema>; candidateId?:string; proposedBy?:Actor; gradedBy?:Actor|null; proposal?:Candidate; proposalEdges?:ProposalEdges};
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
