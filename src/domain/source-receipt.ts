import { ContractError, faultCode } from "./contract-error.js";
import type { RangeClock } from "./range-clock.js";
import type { ExactSpan } from "./source-bound.js";

type Span = [string, string];
type Fragment = {kind: "moment" | "cue"; exactSpan: ExactSpan; state: "clipped" | "unknown"};

export class SourceReceipt {
  readonly uploads: {kind: "audio-window" | "video-cut"; span: Span; rate: RangeClock["grid"]["rate"]}[] = [];
  readonly startFragments: Fragment[] = [];
  readonly endFragments: Fragment[] = [];
  private readonly covered: [bigint, bigint][] = [];
  constructor(readonly clock: RangeClock, readonly recordingSha256: string, readonly maxRangeSeconds: number) {}

  cover(from: bigint, to: bigint) {
    if (this.clock.lengthKnown && from < to) this.covered.push([from, to]);
  }
  document() {
    const {clock} = this;
    const merged: [bigint, bigint][] = [];
    for (const [a,b] of this.covered.slice().sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const last = merged.at(-1);
      if (!last || a > last[1]) merged.push([a,b]);
      else if (b > last[1]) last[1] = b;
    }
    const {unit, length, timing} = clock.grid;
    const lengthField = unit === "frames" ? {sourceLengthFrames: String(length)} : unit === "samples" ? {sourceLengthSamples: String(length)}
      : clock.lengthKnown ? {sourceLengthTicks: String(length)} : {};
    const frameTiming = clock.grid.frameTiming ?? (unit === "samples"
      ? {varying: null, frames: 0, unread: "no picture"} as const
      : {varying: null, frames: null, unread: "unavailable"} as const);
    return {frameTiming, recordingSha256: this.recordingSha256, requestedRange: clock.requestedRange, sourceRange: clock.sourceRange,
      edgeMoved: clock.edgeMoved, ...lengthField, ...(timing && {sourceTiming: timing}), outputMediaClock: "source" as const,
      coverage: {full: clock.lengthKnown && merged.length === 1 && merged[0]![0] === clock.from && merged[0]![1] === clock.to,
        covered: merged.map(([a,b]): Span => [String(a),String(b)])},
      maxRangeSeconds: this.maxRangeSeconds, uploads: this.uploads, edgeRule: "both-edges-report-fragments" as const, endMarginSeconds: 0 as const,
      startFragments: this.startFragments, endFragments: this.endFragments, timePrecision: {modelMs: 1000 as const, snapGridMs: 10 as const}};
  }
}

// Before a local cut leaves the machine there is no remote lifecycle to
// publish. Return only information acquired before the failure.
export function preparationError(error: unknown, source: Record<string, unknown>, tell: (line: string) => void) {
  tell(`Source coverage: ${JSON.stringify(source)}`);
  return new ContractError(faultCode(error), error instanceof ContractError ? error.message : "Could not prepare the recording.",
    {...(error instanceof ContractError && error.details), ...source, phase:error instanceof ContractError && error.details?.engine === "twelvelabs" ? error.details.phase : "prepare", sent:false});
}
