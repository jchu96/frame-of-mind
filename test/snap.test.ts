import { expect, test } from "vitest";
import { classify, proposeRecords, selectEdge, snapSettings, SpeechMeter, summarizeSnaps, type Boundaries, type Edge } from "../src/domain/snap.js";

type Burst = [number, number];
function generated(bursts: Burst[], durationMs: number, speech = 12000, ambient = 0) {
  const pcm = Buffer.alloc(durationMs * 16);
  let seed = 12345;
  for (let i = 0; i < pcm.length / 2; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const amp = bursts.some(([a, b]) => i >= a * 8 && i < b * 8) ? speech : ambient;
    pcm.writeInt16LE(seed >= 2 ** 31 ? amp : -amp, i * 2);
  }
  return pcm;
}
function measure(pcm: Buffer, chunkSize = 8192) {
  const meter = new SpeechMeter(0);
  for (let i = 0; i < pcm.length; i += chunkSize) meter.write(pcm.subarray(i, i + chunkSize));
  return classify(meter.finish()!);
}
const defaults = snapSettings();
const select = (edges: Boundaries, edge: Edge, ms: number) => selectEdge(edges, edge, ms, "source", defaults);
const bursts: Burst[] = [[12340, 15010], [46310, 47990]];
function knownEdges(edges: Boundaries) {
  for (const [edge, request, truth] of [["start", 12000, "12.340"], ["end", 15000, "15.010"], ["end", 48000, "47.990"]] as const) {
    expect(select(edges, edge, request)).toMatchObject({ status: "snapped", target: { seconds: truth, precisionMs: 10 } });
  }
}
test("W1 seeded bursts at 12.340, 15.010 and 47.990 survive split PCM samples", () => {
  const pcm = generated(bursts, 52000);
  const aligned = measure(pcm);
  const split = measure(pcm, 313);
  expect(split).toEqual(aligned);
  knownEdges(split);
});
test("a late model end stops before the remark after the pause", () => {
  const edges = measure(generated([[14000, 20120], [20900, 21600]], 30000));
  const result = select(edges, "end", 21000);
  expect(result.status === "snapped" && result.target.seconds).toBe("20.120");
  expect(result).toMatchObject({ shiftMs: -880, gapMs: 780, alternativesMs: [21600] });
});
test("W3 latest start discloses the remark and search includes only its closed radius", () => {
  const result = select(measure(generated([[11200, 11600], [12300, 13100]], 20000)), "start", 12000);
  expect(result).toMatchObject({ target: { seconds: "12.300" }, alternativesMs: [11200] });
  for (const onset of [6000, 8490, 8500, 11500, 11510]) {
    const edges = measure(generated([[onset, onset + 300]], 20000));
    expect(select(edges, "start", 10000).status).toBe([8500, 11500].includes(onset) ? "snapped" : "no-boundary");
    expect(select(edges, "end", 10300).status).toBe([8500, 11500].includes(onset) ? "snapped" : "no-boundary");
  }
});
test("W4 requires observed pauses and speech including the 250 and 80 ms thresholds", () => {
  for (const edges of [measure(generated([], 30000)), measure(generated([[0, 30000]], 30000))]) {
    for (const edge of ["start", "end"] as const) expect(select(edges, edge, 15000)).toEqual({ status: "no-boundary", alternativesMs: [] });
  }
  for (const length of [70, 80]) for (const pause of [240, 250]) {
    const edges = measure(generated([[pause, pause + length]], pause + length + pause));
    for (const edge of ["start", "end"] as const) {
      expect(select(edges, edge, pause).status).toBe(length === 80 && pause === 250 ? "snapped" : "no-boundary");
    }
  }
  expect(select(measure(generated([[0, 500]], 5000)), "start", 0).status).toBe("no-boundary");
  expect(select(measure(generated([[4000, 5000]], 5000)), "end", 5000).status).toBe("no-boundary");
});
function boundaries(start: number[], end: number[]): Boundaries {
  const point = (ms: number) => ({ ms, gapMs: 500, gapLowerBound: false });
  return { start: start.map(point), end: end.map(point) };
}
test("W5 empty and reversed cuts roll back both proposals and disclose refused choices", () => {
  for (const start of [1100, 1200]) {
    const { records } = proposeRecords([{ start: 1000, end: 1300 }], boundaries([980, start], [1100, 1400]), "source", defaults);
    expect(records[0]).toEqual({ start: { status: "ambiguous", alternativesMs: [980, start] }, end: { status: "ambiguous", alternativesMs: [1100, 1400] } });
  }
});
test("W5 touching and pre-existing overlap survive and neighbor rollback is rechecked in original order", () => {
  const ranges = [{ start: 4300, end: 6300 }, { start: 0, end: 2000 }, { start: 2100, end: 4000 }];
  const run = (end: number) => proposeRecords(ranges, boundaries([2300], [2300, end]), "reel", snapSettings(250, 500));
  expect(run(4300).records.map(r => [r.start.status, r.end.status])).toEqual([
    ["no-boundary", "no-boundary"], ["no-boundary", "snapped"], ["snapped", "snapped"],
  ]);
  expect(run(4450).records[1]!.end).toEqual({ status: "ambiguous", alternativesMs: [2300] });
  expect(run(4450).records[2]!.start).toEqual({ status: "ambiguous", alternativesMs: [2300] });
  const overlapping = proposeRecords([{ start: 0, end: 1800 }, { start: 1500, end: 2500 }], boundaries([], [1750]), "source", snapSettings(250, 250));
  expect(overlapping.records[0]!.end.status).toBe("snapped");
});
test("W6 quiet speech at -30 dBFS and a raised -32 dBFS floor yield the same three edges", () => {
  knownEdges(measure(generated(bursts, 52000, 1036)));
  knownEdges(measure(generated(bursts, 52000, 4100, 824)));
});
test("summary gives all statuses and handles empty and even signed-shift populations by nearest rank", () => {
  expect(summarizeSnaps({ settings: defaults, records: [] })).toEqual({ counts: { snapped: 0, ambiguous: 0, unavailable: 0, "no-boundary": 0 }, total: 0 });
  expect(summarizeSnaps(proposeRecords([{ start: 1000, end: 2000 }], boundaries([1200], [1700]), "source", defaults)).medianShiftMs).toBe(-300);
});
