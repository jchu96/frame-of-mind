import { expect, test } from "vitest";
import { classify, proposeRecords, selectEdge, snapSettings, speechLevels, SpeechMeter, summarizeSnaps, type Boundaries, type Edge } from "../src/domain/snap.js";

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
function knownEdges(edges: Boundaries, precisionMs = 200) {
  for (const [edge, request, truth] of [["start", 12000, "12.340"], ["end", 15000, "15.010"], ["end", 48000, "47.990"]] as const) {
    expect(select(edges, edge, request)).toMatchObject({ status: "snapped", target: { seconds: truth, gridMs: 10, precisionMs } });
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
    expect(select(edges, "start", 10000).status).toBe(onset === 11500 ? "snapped" : "no-boundary");
    expect(select(edges, "end", 10300).status).toBe(onset === 8500 ? "snapped" : "no-boundary");
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
  const point = (ms: number, oppositeMs: number) => ({ ms, oppositeMs, gapMs: 500, gapLowerBound: false, sound: { floorDbfs: -96, speechAboveFloorDb: 80, noisy: false } });
  return { precisionMs: 50, start: start.map(ms => ({ ...point(ms, ms + 500), coreStartMs: ms, coreEndMs: ms + 500 })), end: end.map(ms => point(ms, ms - 500)) };
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
  knownEdges(measure(generated(bursts, 52000, 4100, 824)), 300);
});
test("summary gives all statuses and handles empty and even signed-shift populations by nearest rank", () => {
  expect(summarizeSnaps({ settings: defaults, records: [] })).toEqual({ counts: { snapped: 0, ambiguous: 0, unavailable: 0, "no-boundary": 0 }, total: 0 });
  expect(summarizeSnaps(proposeRecords([{ start: 1000, end: 2000 }], boundaries([1200], [1700]), "source", defaults)).medianShiftMs).toBe(-300);
});

function taperedTone(noiseBelowSpeechDb: number) {
  const pcm = Buffer.alloc(3000 * 16);
  const peak = 12000;
  const noiseRms = peak / Math.SQRT2 * 10 ** (-noiseBelowSpeechDb / 20);
  let seed = 12345;
  for (let sample = 0; sample < pcm.length / 2; sample++) {
    // One random sign per tone cycle keeps the background power steady in every 10 ms window.
    if (sample % 8 === 0) seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed >= 2 ** 31 ? noiseRms : -noiseRms;
    const ms = sample / 8;
    const quiet = ms < 1150 || ms >= 1850;
    const amplitude = ms >= 1000 && ms < 2000 ? peak * (quiet ? 10 ** (-32 / 20) : 1) : 0;
    pcm.writeInt16LE(Math.round(noise + amplitude * Math.sin(sample % 8 * Math.PI / 4)), sample * 2);
  }
  return pcm;
}

test.each([Infinity, 38, 32, 26])("quiet tone ends over noise %s dB below speech keep the word to stated precision", noiseDb => {
  const edges = measure(taperedTone(noiseDb));
  for (const [edge, truth] of [["start", 1000], ["end", 2000]] as const) {
    const result = select(edges, edge, truth);
    expect(result.status).toBe("snapped");
    if (result.status !== "snapped") throw new Error("Expected a measured tone edge");
    const inwardMs = edge === "start" ? result.shiftMs : -result.shiftMs;
    // Edge accuracy is held to one frame down to 32 dB whatever the noisy flag says; below that, to the stated 300 ms.
    const toleranceMs = noiseDb < 30 ? 300 : 40; // one frame at 25 fps
    expect(inwardMs, edge + " inside the tone (ms)").toBeLessThanOrEqual(toleranceMs);
    expect(-inwardMs, edge + " outside the tone (ms)").toBeLessThan(120);
  }
});

test.each([Infinity, 38, 32, 26])("the measured speech contrast at %s dB controls both edges and the noisy count", noiseDb => {
  const edges = measure(taperedTone(noiseDb));
  for (const precisionMs of [50, 200] as const) {
    const run = proposeRecords([{ start: 1000, end: 2000 }], { ...edges, precisionMs }, "source", defaults);
    const noisy = noiseDb < 60; // only the clean film keeps the clean-sound precision
    for (const [edge, result] of Object.entries(run.records[0]!)) {
      expect(result).toMatchObject({ status: "snapped", noisy, target: { precisionMs: noisy ? 300 : precisionMs } });
      if (result.status !== "snapped") throw new Error("Expected measured speech");
      if (Number.isFinite(noiseDb)) {
        expect(result.floorDbfs).toBeCloseTo(20 * Math.log10(12000 / Math.SQRT2 / 32768) - noiseDb, 1);
        expect(result.speechAboveFloorDb).toBeCloseTo(noiseDb, 1);
      } else expect(result.speechAboveFloorDb).toBeGreaterThanOrEqual(60);
      if (edge === "start" && precisionMs === 50) {
        console.info(`Synthetic ${noiseDb} dB: floor ${result.floorDbfs!.toFixed(3)} dBFS, speech ${result.speechAboveFloorDb!.toFixed(3)} dB above floor, noisy=${result.noisy}`);
      }
    }
    const summary = summarizeSnaps(run);
    expect(summary.counts.noisy ?? 0).toBe(noisy ? 2 : 0);
    expect(summary.total).toBe(2);
  }
});

test("speech confidence uses mean power and flags a run with no complete window", () => {
  // Two equal windows at -10 and -30 dBFS average to about -12.97 dBFS.
  const levels = new Float32Array(300).fill(-42);
  for (let i = 100; i < 120; i++) levels[i] = i % 2 ? -30 : -10;
  const edges = classify({ blocks: [levels], startMs: 0, length: levels.length });
  expect(select(edges, "start", 1000)).toMatchObject({ speechAboveFloorDb: expect.closeTo(29.03, 2), noisy: true });
  expect(speechLevels(1, 1, -60)).toMatchObject({ speechAboveFloorDb: 60, noisy: false });
  expect(speechLevels(1, 1, -59.9)).toMatchObject({ noisy: true });
  expect(speechLevels(1, 1, -38)).toMatchObject({ speechAboveFloorDb: 38, noisy: true });
  expect(speechLevels(0, 0, -54)).toEqual({ floorDbfs: -54, noisy: true });
});
