import { z } from "zod";
import { actorSchema, basisSchema, candidateSchema, type Candidate } from "./candidates.js";
import { rateSchema } from "./media-clock.js";
import type { RangeClock } from "./range-clock.js";
import { boundSchema, indexSchema, type Bound, type ExactSpan } from "./source-bound.js";
import type { Edge } from "./snap.js";

const common = {
  clock:z.literal("source"), origin:z.literal("model"), at:z.int().nonnegative(),
  precisionMs:z.int().positive(), by:actorSchema, basis:basisSchema, pass:z.int().nonnegative(),
};
export const claimSchema = z.discriminatedUnion("unit", [
  z.strictObject({...common,unit:z.literal("video-frame"),frames:indexSchema,rate:rateSchema}),
  z.strictObject({...common,unit:z.literal("sample"),samples:indexSchema,rate:rateSchema}),
  z.strictObject({...common,unit:z.literal("tick"),ticks:indexSchema,tick:rateSchema}),
]);
export type Claim = z.infer<typeof claimSchema>;
export const proposalEdgesSchema = z.strictObject({start:claimSchema,end:claimSchema});
export type ProposalEdges = z.infer<typeof proposalEdgesSchema>;
const measured = z.strictObject({status:z.literal("measured"),bound:boundSchema.refine(b => b.origin !== "model"),
  by:z.strictObject({engine:z.literal("frame-of-mind"),model:z.null()})});
const claimed = z.strictObject({status:z.literal("claim"),bound:claimSchema,by:actorSchema});
const resolved = z.discriminatedUnion("status",[measured,claimed]);
export const resolvedEdgesSchema = z.strictObject({start:resolved,endExclusive:resolved});
export type ResolvedEdges = z.infer<typeof resolvedEdgesSchema>;
export const itemProvenance = {
  candidateId:z.string().min(1).optional(), proposedBy:actorSchema.optional(), gradedBy:actorSchema.optional(),
  proposal:candidateSchema.optional(), proposalMembers:z.array(candidateSchema).min(2).optional(),
  resolvedEdges:resolvedEdgesSchema.optional(),
};

export function proposalEdges(row: Candidate, clock: RangeClock): ProposalEdges {
  function claim(edge: Edge): Claim {
    const pass = row.chain.findLast(p => p.edge === edge);
    const at = pass?.at ?? row[edge];
    const unclipped = BigInt(at);
    const end = clock.observedEnd;
    const index = String(unclipped < clock.from ? clock.from : end !== undefined && unclipped > end ? end : unclipped);
    const base = {clock:"source" as const, origin:"model" as const, at, precisionMs:pass?.precisionMs ?? row.precisionMs[edge],
      by:pass?.by ?? row.proposedBy, basis:pass?.basis ?? row.basis[edge], pass:pass?.pass ?? 0};
    const {unit,rate} = clock.grid;
    if (unit === "ticks") return {...base,unit:"tick",ticks:index,tick:{num:rate.den,den:rate.num}};
    return unit === "frames" ? {...base,unit:"video-frame",frames:index,rate} : {...base,unit:"sample",samples:index,rate};
  }
  return {start:claim("start"),end:claim("end")};
}

export function resolveEdges(span: ExactSpan, claims: ProposalEdges, snaps: Partial<Record<Edge, Bound>>): ResolvedEdges {
  function edge(bound: Bound, claim: Claim, snap?: Bound): ResolvedEdges["start"] {
    const measurement = bound.origin === "cut" ? bound : snap?.origin === "snap" ? snap : undefined;
    return measurement ? {status:"measured", bound:measurement, by:{engine:"frame-of-mind",model:null}}
      : {status:"claim", bound:claim, by:claim.by};
  }
  return {start:edge(span.start,claims.start,snaps.start),endExclusive:edge(span.endExclusive,claims.end,snaps.end)};
}

/** Width is a radius in milliseconds. A VFR floor uses observed frame times around the claim. */
export function measurementWindow(claim: Claim, clock: RangeClock, configured: number): number | undefined {
  if (claim.precisionMs > 3000) return;
  const width = Math.min(configured, claim.precisionMs);
  const {rate} = clock.grid;
  let units = 2n;
  if (clock.grid.unit === "ticks") {
    const ticks = clock.frameTicks;
    if (ticks.length < 3) return;
    let lo = 0, hi = ticks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ticks[mid]! < claim.at) lo = mid + 1; else hi = mid;
    }
    const first = Math.max(0, Math.min(ticks.length - 3, lo - 1));
    units = BigInt(ticks[first + 2]! - ticks[first]!);
  }
  if (BigInt(width) * BigInt(rate.num) < units * 1000n * BigInt(rate.den)) return;
  return width;
}
