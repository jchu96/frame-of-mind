import { rationalRate } from "exact-time";
import { z } from "zod";
import { ContractError, UsageError } from "./contract-error.js";
import { rateSchema, sameRate } from "./media-clock.js";
import { indexSchema, modelSpan } from "./source-bound.js";
import { timestampToSeconds } from "../lib/time.js";
import type { RangeClock } from "./range-clock.js";

const count = z.int().nonnegative();
const ms = z.int().positive();
export const actorSchema = z.strictObject({ engine: z.string(), model: z.string().nullable() });
export const basisSchema = z.enum(["model", "word", "shot", "speech", "person", "search-hit"]);
const reducedRatio = z.strictObject({num:z.int().positive(), den:z.int().positive()}).refine(
  r => rateSchema.safeParse(r).success && sameRate(r, rationalRate(r.num, r.den)), "Ratio must be reduced.");
const identity = { recordingSha256: z.string().regex(/^[a-f0-9]{64}$/), length: indexSchema };
export const recordingSchema = z.discriminatedUnion("unit", [
  z.strictObject({ ...identity, unit: z.literal("video-frame"), rate: reducedRatio }),
  z.strictObject({ ...identity, unit: z.literal("sample"), rate: reducedRatio }),
  z.strictObject({ ...identity, unit: z.literal("tick"), length: indexSchema.nullable(), tick: reducedRatio }),
]);
const passSchema = z.strictObject({
  pass: z.int().positive(), edge: z.enum(["start", "end"]), at: count,
  precisionMs: ms, basis: basisSchema, by: actorSchema,
});
export const claimTextLimits = {reason:10_000, surface:500, label:120} as const;

export const candidateSchema = z.strictObject({
  id: z.string().min(1), start: count, end: count,
  precisionMs: z.strictObject({ start: ms, end: ms }),
  basis: z.strictObject({ start: basisSchema, end: basisSchema }),
  label: z.string().max(claimTextLimits.label), reason: z.string().max(claimTextLimits.reason),
  surface: z.string().max(claimTextLimits.surface).optional(), proposedBy: actorSchema,
  score: z.number().optional(), searchPhrase: z.string().optional(), definition: z.string().optional(),
  chain: z.array(passSchema),
});
export type Candidate = z.infer<typeof candidateSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type CandidateRecording = z.infer<typeof recordingSchema>;

/** Map seconds on the sent bytes through the same source bounds as the writer.
 * The observed limit bounds candidate positions even if duration is unknown. */
export function modelProposalSpan(clock: RangeClock, moment: {start:string; end:string}) {
  const limit = clock.observedEnd;
  return modelSpan(clock, timestampToSeconds(moment.start), timestampToSeconds(moment.end),
    0n, limit === undefined ? undefined : clock.cutIndex(limit));
}

export function recordingIdentity(clock: RangeClock, recordingSha256: string): CandidateRecording {
  const { grid } = clock;
  const common = { recordingSha256, length: String(grid.length) };
  if (grid.unit === "ticks") return { ...common, unit: "tick", length: clock.lengthKnown ? common.length : null, tick: { num: grid.rate.den, den: grid.rate.num } };
  return { ...common, unit: grid.unit === "frames" ? "video-frame" : "sample", rate: grid.rate };
}

const ratioOf = (r: CandidateRecording) => r.unit === "tick" ? r.tick : r.rate;

function validChain(row: Candidate, recording: CandidateRecording): boolean {
  const length = recording.length === null ? undefined : BigInt(recording.length);
  const outside = (n: number) => length !== undefined && BigInt(n) > length;
  if (row.start >= row.end || outside(row.end)) return false;
  const ratio = ratioOf(recording);
  const numerator = BigInt(recording.unit === "tick" ? ratio.den : ratio.num);
  const denominator = BigInt(recording.unit === "tick" ? ratio.num : ratio.den);
  const at = { start: row.start, end: row.end };
  const radius = { ...row.precisionMs };
  let i = 0;
  // Grid placement changes both endpoints atomically. Subsequent passes tighten one edge.
  if (row.basis.start === "search-hit" && row.basis.end === "search-hit" && row.chain.length) {
    const [a, b] = row.chain;
    if (!a || !b || a.edge !== "start" || b.edge !== "end" || a.pass !== 1 || b.pass !== 2 ||
        a.basis !== "model" || b.basis !== "model" || a.precisionMs !== 1000 || b.precisionMs !== 1000 ||
        a.by.engine !== b.by.engine || a.by.model !== b.by.model || a.at >= b.at || outside(b.at)) return false;
    const width = BigInt(row.end) - BigInt(row.start);
    if (BigInt(a.at) < BigInt(row.start) - width || BigInt(b.at) > BigInt(row.end) + width) return false;
    at.start = a.at;
    at.end = b.at;
    radius.start = radius.end = 1000;
    i = 2;
  }
  for (; i < row.chain.length; i++) {
    const p = row.chain[i]!;
    const edge = p.edge;
    if (p.pass !== i + 1 || outside(p.at) || p.precisionMs >= radius[edge]) return false;
    const displacement = BigInt(Math.abs(p.at - at[edge])) * denominator * 1000n;
    if (displacement > BigInt(radius[edge] - p.precisionMs) * numerator) return false;
    at[edge] = p.at;
    radius[edge] = p.precisionMs;
    if (at.start >= at.end) return false;
  }
  return true;
}

export const candidatesDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1), recording: recordingSchema, candidates: z.array(candidateSchema),
}).superRefine((doc, ctx) => {
  const seen = new Set<string>();
  for (const [i, candidate] of doc.candidates.entries()) {
    if (seen.has(candidate.id) || !validChain(candidate, doc.recording)) {
      ctx.addIssue({ code: "custom", path: ["candidates", i], message: "Invalid candidate identity, span or chain." });
    }
    seen.add(candidate.id);
  }
});
export type CandidatesDocument = z.infer<typeof candidatesDocumentSchema>;

export function readCandidates(value: unknown, local: CandidateRecording, source: "file" | "engine", observedEnd?: bigint): Candidate[] {
  const result = candidatesDocumentSchema.safeParse(value);
  if (result.success) {
    const { recording, candidates } = result.data;
    const positionOutside = local.length === null && candidates.some(row =>
      observedEnd === undefined || BigInt(row.end) > observedEnd || row.chain.some(p => BigInt(p.at) > observedEnd));
    if (positionOutside && source === "file") throw new UsageError("invalid-candidates", "Candidate outside the observed recording.");
    if (!positionOutside && recording.recordingSha256 === local.recordingSha256 && (local.length === null || recording.length === local.length) &&
        recording.unit === local.unit && sameRate(ratioOf(recording), ratioOf(local))) return candidates;
  }
  if (source === "engine") throw new ContractError("PROVIDER_REFUSED", "Invalid proposer reply.", { phase: "propose", reason: "invalid-reply" });
  throw new UsageError(result.success ? "candidate-recording-mismatch" : "invalid-candidates", "Invalid candidates file.");
}
