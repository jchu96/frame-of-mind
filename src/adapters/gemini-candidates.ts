import { recordingIdentity, type Candidate, type CandidatesDocument } from "../domain/candidates.js";
import type { RangeClock } from "../domain/range-clock.js";
import type { IndexedMoment } from "../domain/types.js";
import { timestampToSeconds } from "../lib/time.js";

/** Bind the validated whole-second response to the original source and the sent window. */
export function geminiCandidates(moments: readonly IndexedMoment[], model: string, clock: RangeClock, digest: string): CandidatesDocument {
  const candidates: Candidate[] = [];
  for (const [ordinal, moment] of moments.entries()) {
    const start = clock.sourceIndex(clock.unitsForSeconds(timestampToSeconds(moment.start)));
    const end = clock.sourceIndex(clock.unitsForSeconds(timestampToSeconds(moment.end), true));
    const limit = clock.observedEnd;
    const clippedEnd = limit !== undefined && end > limit ? limit : end;
    if (start >= clippedEnd) continue;
    candidates.push({
      id: `gemini-${ordinal + 1}`, start: Number(start), end: Number(clippedEnd),
      precisionMs:{start:1000,end:1000}, basis:{start:"model",end:"model"}, proposedBy:{engine:"gemini",model},
      label:moment.kind, reason:moment.summary, score:{high:3,medium:2,low:1}[moment.importance], chain:[],
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
      const index = await analyzer.index(...args);
      const document = geminiCandidates(index.moments,analyzer.model,clock,digest);
      const metadata = new Map(index.moments.map((window,i) => [`gemini-${i+1}`,window]));
      return {index,document,metadata};
    },
    grade:analyzer.interrogate.bind(analyzer),
  };
}
