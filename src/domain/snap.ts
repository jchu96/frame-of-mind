import { OptionError } from "./contract-error.js";
import { exactSeconds, fromMilliseconds } from "exact-time";
import type { FileClock } from "./clock.js";

export type Edge = "start" | "end";
export type SnapSettings = { method: "audio-envelope"; gapMs: number; windowMs: number };
export function snapSettings(gapMs = 250, windowMs = 1500): SnapSettings {
  for (const [name, value, min, max] of [["gap", gapMs, 80, 2000], ["window", windowMs, 250, 3000]] as const) {
    if (!Number.isInteger(value) || value < min || value > max) throw new OptionError(name === "gap" ? "invalid-snap-gap" : "invalid-snap-window", `--snap-${name}-ms must be an integer from ${min} to ${max}.`);
  }
  return { method: "audio-envelope", gapMs, windowMs };
}

export function decimalMs(ms: number): string {
  return exactSeconds(fromMilliseconds("source", String(ms)));
}

export type MeasuredTime = { clock: FileClock; seconds: string; gridMs: 10; precisionMs: 50 | 200 | 300; origin: "audio-envelope" };
export function describeMeasurement(time: Pick<MeasuredTime, "gridMs" | "precisionMs">): string {
  return `measured on a ${time.gridMs} ms grid, accurate to about ±${time.precisionMs} ms`;
}

type SoundLevels = { floorDbfs: number; speechAboveFloorDb?: number; noisy: boolean };
// The clean-sound precision (50 or 200 ms) is claimed only on clean sound. Below this contrast a snap keeps
// its time but states 300 ms and noisy. No level line separates right edges from wrong ones under noise
// (measured on three synthetic benches), so the line sits above every noisy film and below every clean one.
export const NOISY_BELOW_DB = 60;

/** Each complete window contributes its mean square in linear full-scale units. */
export function speechLevels(powerSum: number, windows: number, floorDbfs: number): SoundLevels {
  if (windows < 1) return { floorDbfs, noisy: true };
  const speechAboveFloorDb = 10 * Math.log10(powerSum / windows) - floorDbfs;
  return { floorDbfs, speechAboveFloorDb, noisy: speechAboveFloorDb < NOISY_BELOW_DB };
}

export function describeSound({ floorDbfs, speechAboveFloorDb, noisy }: Partial<SoundLevels>): string {
  const parts = [];
  if (noisy) parts.push("noisy");
  if (floorDbfs !== undefined) parts.push(`floor ${floorDbfs.toFixed(1)} dBFS`);
  if (speechAboveFloorDb !== undefined) parts.push(`speech ${speechAboveFloorDb.toFixed(1)} dB above floor`);
  return parts.join(", ");
}

export type SnapResult =
  | ({ status: "snapped"; target: MeasuredTime; shiftMs: number; gapMs: number; gapLowerBound?: true; alternativesMs: number[] } & Partial<SoundLevels>)
  | { status: "ambiguous" | "no-boundary"; alternativesMs: number[] }
  | { status: "unavailable" };
export type SnapRun = {
  settings: SnapSettings;
  records: Record<Edge, SnapResult>[];
  precisionMs?: 50 | 200;
  noisyEdges?: Record<Edge, ReadonlySet<number>>;
};

const SAMPLES = 80;
const WINDOW_MS = 10;
const BLOCK = 1000;
const FIND_DB = 10;
const EDGE_DB = 1.5;
export interface Envelope {
  sourceSampleRateHz?: number;
  startMs: number;
  blocks: Float32Array[];
  length: number;
}

/** A partial first or last window is never observed. Blocks avoid copying the meter as it grows. */
export class SpeechMeter {
  readonly envelope: Envelope;
  private skip: number;
  private lowByte: number | undefined;
  private samples = 0;
  private squares = 0;
  bytes = 0;

  constructor(firstSample: number) {
    const firstWindow = Math.max(0, Math.ceil(firstSample / SAMPLES));
    this.skip = firstWindow * SAMPLES - firstSample;
    this.envelope = { startMs: firstWindow * WINDOW_MS, blocks: [], length: 0 };
  }

  write(chunk: Uint8Array) {
    this.bytes += chunk.length;
    let i = 0;
    if (this.lowByte !== undefined && chunk.length) {
      this.sample(this.lowByte | (chunk[i++]! << 8));
      this.lowByte = undefined;
    }
    for (; i + 1 < chunk.length; i += 2) this.sample(chunk[i]! | (chunk[i + 1]! << 8));
    if (i < chunk.length) this.lowByte = chunk[i];
  }

  private sample(unsigned: number) {
    if (this.skip > 0) { this.skip--; return; }
    const sample = unsigned >= 32768 ? unsigned - 65536 : unsigned;
    this.squares += sample * sample;
    if (++this.samples !== SAMPLES) return;
    const { blocks, length } = this.envelope;
    if (length % BLOCK === 0) blocks.push(new Float32Array(BLOCK));
    blocks[blocks.length - 1]![length % BLOCK] = Math.max(-96, 10 * Math.log10(this.squares / SAMPLES / 32768 ** 2));
    this.envelope.length++;
    this.squares = this.samples = 0;
  }

  finish(): Envelope | undefined {
    return this.lowByte === undefined ? this.envelope : undefined;
  }
}

type Boundary = { ms: number; oppositeMs: number; gapMs: number; gapLowerBound: boolean; sound: SoundLevels };
export type Boundaries = {
  start: (Boundary & { coreStartMs: number; coreEndMs: number })[];
  end: Boundary[];
  precisionMs: 50 | 200;
};

/** Sorted sliding neighborhood, [i - 1500, i + 1500), clipped at observed ends. */
export function classify(envelope: Envelope): Boundaries {
  const { startMs, length, blocks } = envelope;
  const level = (i: number) => blocks[Math.floor(i / BLOCK)]![i % BLOCK]!;
  const sorted = new Float32Array(3000);
  let count = 0;
  function position(value: number) {
    let lo = 0, hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]! < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  const floors = new Float32Array(length);
  let left = 0, right = 0;
  for (let i = 0; i < length; i++) {
    if (left < i - 1500) {
      const at = position(level(left++));
      sorted.copyWithin(at, at + 1, count);
      count--;
    }
    while (right < Math.min(length, i + 1500)) {
      const value = level(right++);
      const at = position(value);
      sorted.copyWithin(at + 1, at, count);
      count++;
      sorted[at] = value;
    }
    floors[i] = sorted[Math.ceil(count * 0.2) - 1]!;
  }

  const above = (i: number, db: number) => level(i) > floors[i]! + db;
  const ms = (i: number) => startMs + i * WINDOW_MS;
  const boundaries: Boundaries = { start: [], end: [], precisionMs: (envelope.sourceSampleRateHz ?? 0) >= 32000 ? 50 : 200 };
  let previousEnd = 0;
  let pendingEnd: Boundary | undefined;
  function finishPause(nextStart: number, atLimit: boolean) {
    if (pendingEnd) boundaries.end.push({ ...pendingEnd, gapMs: (nextStart - previousEnd) * WINDOW_MS, gapLowerBound: atLimit });
    pendingEnd = undefined;
  }
  let i = 0;
  while (i < length) {
    if (!above(i, FIND_DB)) { i++; continue; }
    const coreStart = i;
    let powerSum = 0;
    while (i < length && above(i, FIND_DB)) {
      powerSum += 10 ** (level(i) / 10);
      i++;
    }
    const coreLength = i - coreStart;

    let onset = coreStart;
    while (onset > previousEnd && above(onset - 1, EDGE_DB)) onset--;
    // A quiet shoulder can touch the next core, but cannot consume it.
    while (i < length && above(i, EDGE_DB) && !above(i, FIND_DB)) i++;
    finishPause(onset, false);
    if (coreLength >= 8) {
      boundaries.start.push({
        ms: ms(onset), oppositeMs: ms(i), coreStartMs: ms(coreStart), coreEndMs: ms(coreStart + coreLength),
        sound: speechLevels(powerSum, coreLength, floors[onset]!),
        gapMs: (onset - previousEnd) * WINDOW_MS, gapLowerBound: previousEnd === 0,
      });
      pendingEnd = { ms: ms(i), oppositeMs: ms(onset), gapMs: 0, gapLowerBound: false,
        sound: speechLevels(powerSum, coreLength, floors[i - 1]!) };
    }
    previousEnd = i;
  }
  finishPause(length, true);
  return boundaries;
}

export function selectEdge(edges: Boundaries | undefined, edge: Edge, atMs: number, clock: FileClock, settings: SnapSettings, otherEdgeMs?: number): SnapResult {
  if (!edges) return { status: "unavailable" };
  const eligible = edges[edge].filter(e => e.gapMs >= settings.gapMs && Math.abs(e.ms - atMs) <= settings.windowMs &&
    (otherEdgeMs === undefined || (edge === "start" ? e.ms < otherEdgeMs : e.ms > otherEdgeMs)));
  // Moving outward may only finish the classified group containing the request.
  // Groups include their onset and exclude their offset.
  const permitted = eligible.filter(e => edge === "start"
    ? e.ms >= atMs || atMs < e.oppositeMs
    : e.ms <= atMs || atMs >= e.oppositeMs);
  const chosen = edge === "start" ? permitted.at(-1) : permitted[0];
  if (!chosen) return { status: "no-boundary", alternativesMs: eligible.map(e => e.ms) };
  return {
    status: "snapped", target: { clock, seconds: decimalMs(chosen.ms), gridMs: WINDOW_MS, precisionMs: chosen.sound.noisy ? 300 : edges.precisionMs, origin: "audio-envelope" },
    ...chosen.sound,
    shiftMs: chosen.ms - atMs, gapMs: chosen.gapMs, ...(chosen.gapLowerBound ? { gapLowerBound: true } : {}),
    alternativesMs: eligible.filter(e => e !== chosen).map(e => e.ms),
  };
}

type Range = Record<Edge, number>;
export function proposeRecords(ranges: Range[], edges: Boundaries | undefined, clock: FileClock, settings: SnapSettings,
  windows?: readonly Record<Edge, {width:number; minMs:number; maxMs:number} | undefined>[]): SnapRun {
  function select(r: Range, i: number, edge: Edge): SnapResult {
    const mate = r[edge === "start" ? "end" : "start"];
    if (!windows) return selectEdge(edges, edge, r[edge], clock, settings, mate);
    const search = windows[i]?.[edge];
    if (!search) return {status:"unavailable"};
    const within = edges && {...edges, [edge]:edges[edge].filter(e => e.ms >= search.minMs && e.ms <= search.maxMs)};
    return selectEdge(within, edge, r[edge], clock, {...settings,windowMs:search.width}, mate);
  }
  const records = ranges.map((r,i) => ({
    start: select(r,i,"start"),
    end: select(r,i,"end"),
  }));
  const order = ranges.map((r, i) => ({ ...r, i })).sort((a, b) => a.start - b.start || a.end - b.end);
  const overlap = (a: Range, b: Range) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  for (;;) {
    const conflicts = new Set<number>();
    const proposed = ranges.map((r, i) => {
      const { start, end } = records[i]!;
      return { start: r.start + (start.status === "snapped" ? start.shiftMs : 0), end: r.end + (end.status === "snapped" ? end.shiftMs : 0) };
    });
    for (const [index, current] of order.entries()) {
      const range = proposed[current.i]!;
      if (range.start >= range.end) conflicts.add(current.i);
      const prev = order[index - 1];
      if (!prev) continue;
      const neighbor = proposed[prev.i]!;
      if (overlap(neighbor, range) > overlap(prev, current) || (prev.end <= current.start && neighbor.start >= range.end)) {
        conflicts.add(prev.i);
        conflicts.add(current.i);
      }
    }
    let changed = false;
    for (const i of conflicts) for (const edge of ["start", "end"] as const) {
      const result = records[i]![edge];
      if (result.status !== "snapped") continue;
      records[i]![edge] = { status: "ambiguous", alternativesMs: [...result.alternativesMs, ranges[i]![edge] + result.shiftMs].sort((a, b) => a - b) };
      changed = true;
    }
    if (!changed) break;
  }
  if (!edges) return { settings, records };
  // Alternatives (including rolled-back proposals) refer to classified edges by file time.
  const noisyTimes = (points: Boundary[]) => new Set(points.filter(p => p.sound.noisy).map(p => p.ms));
  return { settings, records, precisionMs: edges.precisionMs, noisyEdges: { start: noisyTimes(edges.start), end: noisyTimes(edges.end) } };
}

export function summarizeSnaps(run: SnapRun) {
  const counts = { snapped: 0, "no-boundary": 0, ambiguous: 0, unavailable: 0 };
  const shifts: number[] = [];
  let noisy = 0;
  for (const record of run.records) for (const result of [record.start, record.end]) {
    counts[result.status]++;
    if (result.status === "snapped") {
      shifts.push(result.shiftMs);
      if (result.noisy) noisy++;
    }
  }
  shifts.sort((a, b) => a - b);
  // Empirical 50th percentile (nearest rank) reports an observed shift even for an even sample.
  const mid = (shifts.length - 1) >>> 1;
  return { counts: { ...counts, ...(noisy ? { noisy } : {}) }, total: Object.values(counts).reduce((a, b) => a + b, 0),
    ...(shifts.length ? { medianShiftMs: shifts[mid]! } : {}) };
}
