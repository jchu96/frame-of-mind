import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { classifyFrameTiming, frameTimingSentence, parseFrameTick } from "../src/domain/frame-timing.js";

const repeat = (gap: number, count: number): number[] => Array(count).fill(gap);
function times(gaps: number[]) {
  const result = [0];
  for (const gap of gaps) result.push(result.at(-1)! + gap);
  return result;
}
const tick = {num: 1, den: 600};
const measure = (gaps: number[], den = 600) => classifyFrameTiming(times(gaps), {num: 1, den});
// Pairs of gap length in ticks and number of successive occurrences.
const runs: [number, number][] = JSON.parse(readFileSync(new URL("./fixtures/frame-gap-runs.json", import.meta.url), "utf8"));
const sample = times(runs.flatMap(([gap, count]) => repeat(gap, count)));

test("measures both rates and their shares across 550 packet times", () => {
  expect(classifyFrameTiming(sample, tick)).toMatchObject({varying: true, frames: 550, oddGaps: 0, averageFramesPerSecond: 26.921,
    rates: [{framesPerSecond: 29.99, share: 0.5446}, {framesPerSecond: 23.985, share: 0.4554}]});
});

test.each([
  [1001, 30000, 30000, 29.97], [1001, 30000, 600, 29.97], [1001, 30000, 90000, 29.97], [1001, 30000, 1000, 29.97],
  [1001, 60000, 60000, 59.94], [1001, 60000, 600, 59.94], [1001, 60000, 1000, 59.94], [1001, 24000, 600, 23.976],
  [1, 25, 600, 25], [1, 30, 15360, 30],
])("measures period %i/%i on a 1/%i clock as one steady rate of %f", (num, den, hz, fps) => {
  const pts = Array.from({length: 2000}, (_, i) => Math.round(i * num * hz / den));
  const report = classifyFrameTiming(pts, {num: 1, den: hz});
  expect(report.varying).toBe(false);
  expect(report.oddGaps).toBe(0);
  expect(report.rates).toHaveLength(1);
  expect(Math.abs(report.rates[0].framesPerSecond - fps)).toBeLessThan(0.01);
  expect(Math.abs(report.averageFramesPerSecond - fps)).toBeLessThan(0.01);
});

test("groups alternating neighbours only within one tick and keeps a sustained neighbour", () => {
  const alternate = (other: number) => Array.from({length: 1000}, (_, i) => i % 2 ? 20 : other);
  expect(measure(alternate(22)).varying).toBe(true);
  expect(measure(alternate(21)).varying).toBe(false);
  expect(measure([...repeat(20, 500), ...repeat(21, 500)])).toMatchObject({varying: true,
    rates: [{framesPerSecond: 30, share: 0.5}, {framesPerSecond: 28.571, share: 0.5}]});
});

test.each([[100, false], [101, true]] as const)("counts %i isolated doubled gaps in 10,000", (count, varying) => {
  const report = measure(Array.from({length: 10000}, (_, i) => i % 50 === 0 && i / 50 < count ? 2000 : 1000), 30000);
  expect(report).toMatchObject({varying, oddGaps: count, rates: [{framesPerSecond: 30}]});
});

test("counts one odd first or last gap without classifying the clip as varying", () => {
  for (const length of [12, 50, 60, 99, 3000]) for (const gap of [7, 13, 31, 40]) for (const index of [0, length - 2]) {
    const gaps = repeat(20, length - 1);
    gaps[index] = gap;
    expect(measure(gaps)).toMatchObject({varying: false, oddGaps: 1, rates: [{framesPerSecond: 30}]});
  }
  const gaps = repeat(20, 59);
  gaps[10] = 31;
  gaps[40] = 7;
  expect(measure(gaps).varying).toBe(true);
});

test("counts a second rate from five consecutive gaps, even in a 50-frame clip", () => {
  const section = (count: number) => measure([...repeat(20, 18000), ...repeat(25, count), ...repeat(20, 18000)]);
  const report = section(24);
  expect(report).toMatchObject({varying: true, oddGaps: 0, rates: [{framesPerSecond: 30, share: 0.9993}, {framesPerSecond: 24, share: 0.0007}]});
  expect(frameTimingSentence("c", report)).toContain("about 30 and 24 frames a second");
  expect(section(5)).toMatchObject({varying: true, rates: [{framesPerSecond: 30}, {framesPerSecond: 24}]});
  expect(section(4)).toMatchObject({varying: false, oddGaps: 4, rates: [{framesPerSecond: 30}]});
  expect(measure([...repeat(20, 44), ...repeat(25, 5)])).toMatchObject({frames: 50, varying: true, oddGaps: 0});
});

test("preserves rounding across zero and counts stray gaps outside a sustained rate", () => {
  const pts = Array.from({length: 241}, (_, i) => { const t = (i - 120) * 1501.5; return Math.sign(t) * Math.round(Math.abs(t)); });
  const even = classifyFrameTiming(pts, {num: 1, den: 90000});
  expect(even).toMatchObject({varying: false, oddGaps: 0});
  expect(Math.abs(even.rates[0].framesPerSecond - 59.94)).toBeLessThan(0.01);
  const thirty = (count: number) => Array.from({length: count}, (_, i) => i % 3 === 2 ? 34 : 33);
  const section = Array.from({length: 24}, (_, i) => i % 3 === 2 ? 41 : 42);
  const report = measure([...thirty(9000), 41, 41, ...thirty(9000), ...section, ...thirty(18000)], 1000);
  expect(report).toMatchObject({varying: true, oddGaps: 2});
  expect(report.rates).toHaveLength(2);
  expect(Math.abs(report.rates[1].framesPerSecond - 24)).toBeLessThan(0.01);
});

test("averages each sustained rate over its own gaps", () => {
  const gaps = [...repeat(20, 2000), ...repeat(25, 120)];
  for (let i = 0; i < 100; i++) gaps.push(...repeat(20, 20), 26);
  expect(measure(gaps)).toMatchObject({oddGaps: 100, rates: [{framesPerSecond: 30}, {framesPerSecond: 24}]});
});

test("ignores decode order and repeated timestamps", () => {
  expect(classifyFrameTiming([...sample].reverse().concat(sample.slice(0, 40)), tick)).toEqual(classifyFrameTiming(sample, tick));
});

test("explains a short scan and rejects an unreadable time unit", () => {
  expect(classifyFrameTiming([0, 20], tick)).toEqual({varying: null, frames: 2, unread: "too few frames"});
  for (const unit of [{num: 0, den: 600}, {num: 1, den: 0}, undefined]) {
    expect(() => classifyFrameTiming([0, 20, 40], unit)).toThrow(/Unreadable frame time unit/);
  }
});

test("reads a tick with or without trailing stream side data", () => {
  for (const text of ["1/600\n", "1/600,\n"]) expect(parseFrameTick(text)).toEqual(tick);
  for (const text of ["", "N/A\n", "0/600\n", "1/0\n", undefined]) expect(parseFrameTick(text)).toBeUndefined();
});

test("describes the measured rates or uneven spacing in one sentence", () => {
  const words = frameTimingSentence("clip.MOV", classifyFrameTiming(sample, tick));
  expect(words).toMatch(/^"clip\.MOV" has a frame rate that varies .*about 30 and 24 frames a second.*one frame off\.$/);
  expect(words.split(". ")).toHaveLength(1);
  const uneven = frameTimingSentence("x", measure(Array.from({length: 1000}, (_, i) => i % 2 ? 20 : 22)));
  expect(uneven).toContain("not evenly spaced");
  expect(uneven).not.toContain("frames a second");
  expect(frameTimingSentence("x", measure([20, 20]))).toBe("");
  expect(frameTimingSentence("x", measure([20]))).toBe("");
});
