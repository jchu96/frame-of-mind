import { fromTimecode, isDropRate, TICKS_PER_SECOND, type FrameRate } from "exact-time";
import { ContractError } from "./contract-error.js";

export type RangeUnit = "frames" | "samples" | "ticks";
export interface RangeRequest { from?: string; to?: string }
export interface SourceGrid {
  unit: RangeUnit;
  rate: FrameRate;
  length: bigint;
  dropFrame?: boolean;
  timing?: "varying" | "unproven";
}

type Fraction = { n: bigint; d: bigint };
function fraction(n: bigint, d: bigint): Fraction {
  let a = n < 0n ? -n : n;
  let b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
function formatSeconds({ n, d }: Fraction): string {
  let remaining = d;
  let scale = 0;
  for (const prime of [2n, 5n]) {
    let count = 0;
    while (remaining % prime === 0n) { remaining /= prime; count++; }
    scale = Math.max(count, scale);
  }
  if (remaining !== 1n) return `${n}/${d}`;
  if (!scale) return String(n);
  const digits = String(n * 10n ** BigInt(scale) / d).padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export function rangeUsage(reason: string): never {
  throw new ContractError("USAGE", reason, { reason });
}

// Keep the requested positions as fractions of a grid unit until ordering and EOF have been checked.
function position(value: string, grid: SourceGrid): Fraction {
  if (value.trim() !== value) return rangeUsage("Invalid range bound.");
  if (/^\d+(?:\.\d{1,3})?$/.test(value)) {
    const [seconds, sub = ""] = value.split(".");
    const ms = BigInt(seconds!) * 1000n + BigInt(sub.padEnd(3, "0"));
    return fraction(ms * BigInt(grid.rate.num), 1000n * BigInt(grid.rate.den));
  }
  const frame = /^(0|[1-9]\d*)f$/.exec(value);
  const label = /^(\d{2}|[1-9]\d{2,}):[0-5]\d:[0-5]\d[:;](\d{2}|[1-9]\d{2,})$/.test(value);
  if (grid.unit === "samples") {
    const sample = /^(0|[1-9]\d*)samp$/.exec(value);
    if (sample) return { n: BigInt(sample[1]!), d: 1n };
    if (frame || label) return rangeUsage("Audio bounds use seconds or Nsamp.");
  } else {
    if (frame) return { n: BigInt(frame[1]!), d: 1n };
    if (label) {
      if (grid.dropFrame === undefined && isDropRate(grid.rate)) return rangeUsage("Specify the source drop-frame mode or use frames.");
      try { return { n: fromTimecode("source", value, grid.rate, grid.dropFrame ?? false).frames, d: 1n }; }
      catch { return rangeUsage("Invalid range bound."); }
    }
  }
  return rangeUsage("Invalid range bound.");
}

export class RangeClock {
  private constructor(readonly grid: SourceGrid, readonly from: bigint, readonly to: bigint,
    readonly requestedRange: { from: string | null; to: string | null },
    readonly edgeMoved: { from: boolean; to: boolean }, readonly lengthKnown = true) {}

  static resolve(grid: SourceGrid, request: RangeRequest): RangeClock {
    const start = request.from === undefined ? { n: 0n, d: 1n } : position(request.from, grid);
    const end = request.to === undefined ? { n: grid.length, d: 1n } : position(request.to, grid);
    if (start.n > grid.length * start.d || end.n >= (grid.length + 1n) * end.d) return rangeUsage("a bound outside the recording");
    if (start.n * end.d >= end.n * start.d) return rangeUsage("from at or after to");
    const from = start.n / start.d;
    const to = end.n > grid.length * end.d ? grid.length : (end.n + end.d - 1n) / end.d;
    if (from >= to) return rangeUsage("from at or after to");
    if ((request.from !== undefined || request.to !== undefined) && (to - from) * BigInt(grid.rate.den) < BigInt(grid.rate.num)) {
      return rangeUsage("a range shorter than the tool can analyse");
    }
    return new RangeClock(grid, from, to, { from: request.from ?? null, to: request.to ?? null },
      { from: from * start.d !== start.n, to: to * end.d !== end.n });
  }

  static wholeTicks(tick: FrameRate, length: bigint | undefined, timing: "unproven" | "varying") {
    return new RangeClock({unit: "ticks", rate: {num: tick.den, den: tick.num}, length: length ?? 0n, timing},
      0n, length ?? 0n, {from: null, to: null}, {from: false, to: false}, length !== undefined);
  }
  get cutLength(): bigint | undefined { return this.lengthKnown ? this.to - this.from : undefined; }
  unitsForSeconds(seconds: number, ceil = false) {
    const den = BigInt(this.grid.rate.den);
    return (BigInt(seconds) * BigInt(this.grid.rate.num) + (ceil ? den - 1n : 0n)) / den;
  }
  elapsed(units: bigint) { return Number(units) * this.grid.rate.den / this.grid.rate.num; }
  get sourceRange() {
    const { unit, rate } = this.grid;
    if (unit === "ticks") return {unit, fromTick: String(this.from), toTickExclusive: this.lengthKnown ? String(this.to) : null, tick: {num: rate.den, den: rate.num}};
    return unit === "frames"
      ? { unit, fromFrame: String(this.from), toFrameExclusive: String(this.to), rate }
      : { unit, fromSample: String(this.from), toSampleExclusive: String(this.to), rate };
  }

  sourceIndex(cutIndex: bigint) { return this.from + cutIndex; }
  cutIndex(sourceIndex: bigint) { return sourceIndex - this.from; }

  private seconds(index: bigint) {
    return fraction(index * BigInt(this.grid.rate.den), BigInt(this.grid.rate.num));
  }
  sourceTicks(cutTicks: bigint): Fraction {
    const origin = this.seconds(this.from);
    return fraction(origin.n * TICKS_PER_SECOND + cutTicks * origin.d, origin.d);
  }
  cutTicks(sourceTicks: Fraction): Fraction {
    const origin = this.sourceTicks(0n);
    return fraction(sourceTicks.n * origin.d - origin.n * sourceTicks.d, sourceTicks.d * origin.d);
  }
  rangeLine() {
    const { unit, rate } = this.grid;
    return `Range used: source [${this.from},${this.to}) ${unit} at ${rate.num}/${rate.den} Hz ([${formatSeconds(this.seconds(this.from))},${formatSeconds(this.seconds(this.to))}) s)`;
  }
}
