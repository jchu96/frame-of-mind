import { TICKS_PER_SECOND } from "exact-time";
import { type RangeClock } from "../domain/range-clock.js";
import type { SourceReceipt } from "../domain/source-receipt.js";
import { boundIndex, boundRate, sourceBound, type Bound } from "../domain/source-bound.js";
import type { MeetingEvidence } from "../domain/types.js";
import { timestampToSeconds, secondsToTimestamp } from "../lib/time.js";

function sourceTicks(ms: number, offsetMs: number, bound?: Bound, index?: bigint) {
  if (!bound) return {n:BigInt(ms-offsetMs)*TICKS_PER_SECOND,d:1000n};
  const rate = boundRate(bound), num = BigInt(rate.num);
  return {n:((index ?? boundIndex(bound))*BigInt(rate.den)*1000n-BigInt(offsetMs)*num)*TICKS_PER_SECOND,d:num*1000n};
}

/** Clip on rational coordinates before producing the cut-clock prompt. Keep the original context for its digest. */
export function rangeTranscript(meeting: MeetingEvidence, offset: number, clock: RangeClock, receipt: SourceReceipt) {
  const cues = meeting.transcriptCues?.length ? meeting.transcriptCues : meeting.transcript.split(/\r?\n/).flatMap(line => {
    const m = /^\[(\d{2,}:[0-5]\d:[0-5]\d)\]\s/.exec(line);
    return m ? [{startMs:timestampToSeconds(m[1]!)*1000,text:line.slice(m[0].length),endMs:undefined,exactSpan:undefined}] : [];
  });
  if (!cues.length) return {text:meeting.transcript,windowed:false};
  const shift = offset*1000;
  if (!Number.isSafeInteger(shift)) throw new Error("Transcript offset must be an exact millisecond.");
  const {rate} = clock.grid;
  const cutUnits = (ms: number, bound?: Bound, index?: bigint) => {
    const {n,d} = clock.cutTicks(sourceTicks(ms,shift,bound,index));
    return {n:n*BigInt(rate.num),d:d*TICKS_PER_SECOND*BigInt(rate.den)};
  };
  const length = clock.to-clock.from;
  function retainedBound(index: bigint, original?: Bound) {
    const at = clock.sourceIndex(index);
    if (!original || original.origin === "cut") return sourceBound(clock, at);
    if (original.origin === "snap") return sourceBound(clock, at, {origin:"snap",gridMs:10,precisionMs:original.precisionMs});
    const left = cutUnits(0, original, BigInt(original.support[0]));
    const right = cutUnits(0, original, BigInt(original.support[1]));
    const lo = left.n < 0n ? 0n : left.n / left.d;
    const hi = right.n > length * right.d ? length : (right.n + right.d - 1n) / right.d;
    if (lo >= hi) return sourceBound(clock, at);
    return sourceBound(clock, at, {origin:"model",precisionMs:1000,support:[String(clock.sourceIndex(lo)),String(clock.sourceIndex(hi))]});
  }
  return {windowed:true,text:cues.flatMap(cue => {
    const start = cutUnits(cue.startMs,cue.exactSpan?.start);
    const end = cue.endMs === undefined ? undefined : cutUnits(cue.endMs,cue.exactSpan?.endExclusive);
    if (start.n >= length*start.d || (end ? end.n <= 0n || end.n*start.d <= start.n*end.d : start.n < 0n)) return [];
    const s = start.n < 0n ? 0n : start.n/start.d;
    if (end) {
      const e = end.n > length*end.d ? length : (end.n+end.d-1n)/end.d;
      const exactSpan = {
        start:retainedBound(s, start.n < 0n ? undefined : cue.exactSpan?.start),
        endExclusive:retainedBound(e, end.n > length*end.d ? undefined : cue.exactSpan?.endExclusive),
      };
      if (start.n<0n) receipt.startFragments.push({kind:"cue",state:"clipped",exactSpan});
      if (end.n>length*end.d) receipt.endFragments.push({kind:"cue",state:"clipped",exactSpan});
    }
    const seconds = start.n <= 0n ? 0 : Number(start.n*BigInt(rate.den)/(start.d*BigInt(rate.num)));
    return [`[${secondsToTimestamp(seconds)}] ${cue.text}`];
  }).join("\n")};
}
