import { TICKS_PER_SECOND } from "exact-time";
import { expect, test } from "vitest";
import { RangeClock, type SourceGrid } from "../src/domain/range-clock.js";

const pal = { unit: "frames", rate: { num: 25, den: 1 }, length: 40000n } as const;
const ntsc = { ...pal, rate: { num: 30000, den: 1001 } };
const pcm = { unit: "samples", rate: { num: 44100, den: 1 }, length: 50000n } as const;

test.each([
  [pal, 15000n, 30000n, false, "[600,1200)"],
  [ntsc, 17982n, 35965n, true, "[599.9994,7200193/6000)"],
  [{ ...ntsc, length: 35964n }, 17982n, 35964n, true, "[599.9994,1199.9988)"],
] as const)("resolves the two ten-minute video bounds on the measured grid", (grid, from, to, moved, elapsed) => {
  const clock = RangeClock.resolve(grid, { from: "600", to: "1200" });
  expect(clock.sourceRange).toEqual({ unit: "frames", fromFrame: String(from), toFrameExclusive: String(to), rate: grid.rate });
  expect(clock.requestedRange).toEqual({ from: "600", to: "1200" });
  expect(clock.edgeMoved).toEqual({ from: moved, to: moved });
  expect(clock.rangeLine()).toBe(`Range used: source [${from},${to}) frames at ${grid.rate.num}/${grid.rate.den} Hz (${elapsed} s)`);
});

test("moves and clamps audio edges on the first PCM track's sample grid", () => {
  for (const length of [44144n, 44145n]) {
    const clock = RangeClock.resolve({ ...pcm, length }, { from: "0.001", to: "1.001" });
    expect(clock.sourceRange).toEqual({ unit: "samples", fromSample: "44", toSampleExclusive: String(length), rate: pcm.rate });
    expect(clock.edgeMoved).toEqual({ from: true, to: true });
  }
  expect(RangeClock.resolve(pcm, { from: "44samp" }).edgeMoved).toEqual({ from: false, to: false });
});

test("preserves exact labels, frame indices and omitted bounds", () => {
  const clock = RangeClock.resolve(pal, { from: "00:00:00:01", to: "26f" });
  expect(clock.sourceIndex(25n)).toBe(26n);
  expect(clock.cutIndex(26n)).toBe(25n);
  expect(RangeClock.resolve(pal, {}).requestedRange).toEqual({ from: null, to: null });
  expect(RangeClock.resolve(ntsc, { to: "30f" }).edgeMoved).toEqual({ from: false, to: false });
});

test.each([
  [{ ...ntsc, length: 35964n }, undefined, "1200.033", "a bound outside the recording"],
  [{ ...pal, length: 25n }, undefined, "1.040", "a bound outside the recording"],
  [{ ...pcm, length: 44099n }, undefined, "1.000", "a bound outside the recording"],
  [pal, "1.002", "1.001", "from at or after to"],
  [pal, "1.001", "1.001", "from at or after to"],
  [ntsc, undefined, "29f", "a range shorter than the tool can analyse"],
  [pcm, "1f", undefined, "Audio bounds use seconds or Nsamp."],
  [ntsc, "00:00:00:01", undefined, "Specify the source drop-frame mode or use frames."],
  [pal, "1.0001", undefined, "Invalid range bound."],
  [pal, "-1", undefined, "Invalid range bound."],
] satisfies Array<[SourceGrid, string | undefined, string | undefined, string]>)("refuses an invalid interval with a stable reason", (grid, from, to, reason) => {
  expect(() => RangeClock.resolve(grid, { from, to })).toThrow(expect.objectContaining({ code: "USAGE", details: { reason } }));
});

test.each([[pal, "1f", 51n], [ntsc, "31f", 90n]] as const)("keeps a fractional source origin through a two-second model reading", (grid, from, frame) => {
  const clock = RangeClock.resolve(grid, { from });
  const ticks = clock.sourceTicks(2n * TICKS_PER_SECOND);
  expect(clock.cutTicks(ticks)).toEqual({ n: 2n * TICKS_PER_SECOND, d: 1n });
  expect(ticks.n * BigInt(grid.rate.num) / (ticks.d * TICKS_PER_SECOND * BigInt(grid.rate.den))).toBe(frame);
});
