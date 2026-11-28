import { modelProposalSpan, recordingIdentity, type Candidate, type CandidatesDocument } from "../domain/candidates.js";
import type { RangeClock } from "../domain/range-clock.js";
import type { IndexedMoment } from "../domain/types.js";
import { boundIndex } from "../domain/source-bound.js";

/** Bind the validated whole-second response to the original source and the sent window. */
export function geminiCandidates(moments: readonly IndexedMoment[], model: string, clock: RangeClock, digest: string): CandidatesDocument {
  const candidates: Candidate[] = [];
  for (const [ordinal, moment] of moments.entries()) {
    const span = modelProposalSpan(clock, moment);
    if (!span) continue;
    candidates.push({
      id: `gemini-${ordinal + 1}`, start: Number(boundIndex(span.start)), end: Number(boundIndex(span.endExclusive)),
      precisionMs:{start:1000,end:1000}, basis:{start:"model",end:"model"}, proposedBy:{engine:"gemini",model},
      label:moment.kind, reason:moment.summary, ...(moment.surface !== undefined && {surface:moment.surface}),
      score:{high:3,medium:2,low:1}[moment.importance], ...moment.proposal, chain:[],
    });
  }
  candidates.sort((a,b) => b.score! - a.score! || a.start - b.start);
  return {schemaVersion:1, recording:recordingIdentity(clock,digest), candidates};
}

/** Both roles can share one media transport without sharing prompt data. */
export function geminiEnginePorts(analyzer: import("../services/analyze.js").AnalysisVideoAnalyzer): import("../services/analyze.js").AnalysisEnginePorts {
  return {
    media:analyzer,
    async propose(clock: RangeClock, digest: string, ...args: Parameters<typeof analyzer.index>) {
      const index = analyzer.indexProposals ? await analyzer.indexProposals(...args) : await analyzer.index(...args);
      const document = geminiCandidates(index.moments,analyzer.model,clock,digest);
      const metadata = new Map(index.moments.map(({proposal: _authored, ...window},i) => [`gemini-${i+1}`,window]));
      return {index,document,metadata};
    },
    grade:(...args) => analyzer.interrogate(...args),
  };
}
