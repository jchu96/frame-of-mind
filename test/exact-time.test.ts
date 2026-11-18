import { expect, test } from "vitest";
import { exactTime, renderExactTimecode } from "../src/domain/exact-time.js";

function frameLabel(frames: bigint, rate: { num: number; den: number }): string {
  return renderExactTimecode(exactTime("source", String(frames), rate), false);
}

test("every frame of the first ten minutes renders its own timecode at 24000/1001 and 30000/1001", () => {
  for (const num of [24000, 30000]) {
    const rate = { num, den: 1001 };
    const nominal = num === 24000 ? 24 : 30;
    let h = 0, m = 0, s = 0, f = 0;
    for (let frame = 0n; frame * 1001n <= 600n * BigInt(num); frame++) {
      const expected = [h, m, s, f].map(v => String(v).padStart(2, "0")).join(":");
      expect(frameLabel(frame, rate), `frame ${frame} at ${num}/1001`).toBe(expected);
      if (++f === nominal) { f = 0; if (++s === 60) { s = 0; if (++m === 60) { m = 0; h++; } } }
    }
  }
});

import { renderTimecode } from "../src/domain/clock.js";
import { readFileSync } from "node:fs";
import { deriveExact, exactSeconds, fromMilliseconds, fromTicks, fromTimecode, offsetTime, toOtioTime, toOtioRange } from "../src/domain/exact-time.js";
import { parseTimecodeRate } from "../src/domain/time-rate.js";
import { oracle, oracleLabel, oracleRefusal, type Case } from "./time-contract-oracle.js";
const table = JSON.parse(readFileSync(new URL("../docs/contracts/time-cases.json", import.meta.url), "utf8")) as {
  version: number; rates: { num: number; den: number; dropFrame: boolean }[]; cases: Case[];
};
function execute(row: Case) {
  const clock = row.clock ?? "source";
  if (row.op === "rate") return parseTimecodeRate(row.input);
  let time;
  switch (row.op) {
    case "frames": time = exactTime(clock, row.input, row.rate!); break;
    case "milliseconds": time = fromMilliseconds(clock, row.input, row.rate); break;
    case "ticks": time = fromTicks(clock, row.input, row.rate); break;
    case "timecode": time = fromTimecode(clock, row.input, row.rate!, row.dropFrame!); break;
    case "offset": time = offsetTime(exactTime("source", row.input, row.rate!), exactTime(clock, row.offset!, row.rate!)); break;
    default: throw new Error(`Unknown operation: ${row.op}`);
  }
  return deriveExact(time, row.dropFrame);
}

test("the oracle agrees with every table row", () => {
  for (const row of table.cases) {
    if (row.refused) expect(oracleRefusal(row), row.id).toBe(row.refused);
    else expect(oracle(row), row.id).toEqual(row.expected);
  }
});

test("the runner executed N of N rows in both directions and every rate was exercised", () => {
  let executed = 0;
  const completed = { timecode: 0, ticks: 0, seconds: 0 };
  const timeRows = table.cases.filter(row => !row.refused && row.op !== "rate");
  // These obligations come from the table, independently of the runner branches.
  const expected = {
    timecode: timeRows.filter(row => row.expected?.rate !== undefined).length,
    ticks: timeRows.filter(row => row.expected?.ticks !== undefined).length,
    seconds: timeRows.filter(row => row.expected?.seconds !== undefined).length,
  };
  function readBack(actual: bigint, frames: bigint, row: string): 1 {
    expect(actual, row).toBe(frames);
    return 1; // Count only after the read-back assertion completes.
  }
  const rates = new Set<string>();
  for (const row of table.cases) {
    if (row.refused) {
      expect(() => execute(row), row.id).toThrow(row.refused);
      expect(() => execute(row), row.id).toThrow(/Accepted forms:/);
    } else {
      const actual = execute(row);
      expect(actual, row.id).toEqual(row.expected);
      if (row.op !== "rate") {
        const e = row.expected!;
        const rate = e.rate as { num: number; den: number } | undefined;
        const time = rate ? exactTime(row.clock!, e.frames as string, rate) : fromMilliseconds(row.clock!, e.milliseconds as string);
        if (rate) {
          rates.add(`${rate.num}/${rate.den}/${row.dropFrame}`);
          completed.timecode += readBack(fromTimecode(row.clock!, e.timecode as string, rate, row.dropFrame!).frames, time.frames, row.id);
        }
        if (e.ticks !== undefined) completed.ticks += readBack(fromTicks(row.clock!, e.ticks as string, rate).frames, time.frames, row.id);
        // Check display containment, without treating reading seconds as an exact boundary.
        if (e.seconds !== undefined) completed.seconds += readBack(fromMilliseconds(row.clock!, String(BigInt((e.seconds as string).replace(".", ""))), rate).frames, time.frames, row.id);
        // Exact reconstruction uses the stored frames at the rate, never derived display seconds.
        expect(rate ? exactTime(row.clock!, e.frames as string, rate) : fromMilliseconds(row.clock!, e.milliseconds as string)).toEqual(time);
      }
    }
    executed++;
  }
  for (const direction of ["timecode", "ticks", "seconds"] as const) {
    const receipt = `${direction} read-back completed ${completed[direction]} of ${expected[direction]}`;
    expect(completed[direction], receipt).toBe(expected[direction]);
    process.stdout.write(`${receipt}\n`);
  }
  expect(executed).toBe(table.cases.length);
  for (const rate of table.rates) expect(rates.has(`${rate.num}/${rate.den}/${rate.dropFrame}`)).toBe(true);
  process.stdout.write(`executed ${executed} of ${table.cases.length}\n`);
});

test.each(table.rates)("round trip frames to timecode to frames at $num/$den df=$dropFrame", (rate) => {
  for (let minute = 0; minute <= 60; minute++) {
    const boundary = BigInt(minute) * 60n * BigInt(rate.num) / BigInt(rate.den);
    for (let delta = -5n; delta <= 5n; delta++) {
      const frames = boundary + delta;
      if (frames < 0n) continue;
      const time = exactTime("source", String(frames), rate);
      const label = renderExactTimecode(time, rate.dropFrame);
      expect(label).toBe(oracleLabel(frames, rate.num, rate.den, rate.dropFrame));
      expect(fromTimecode("source", label, rate, rate.dropFrame).frames).toBe(frames);
      const derived = deriveExact(time, rate.dropFrame);
      if (derived.ticks) expect(fromTicks("source", derived.ticks, rate).frames).toBe(frames);
    }
  }
});

test("the OTIO export of a table row has value = frames and rate = num/den", () => {
  for (const row of table.cases.filter(r => r.expected?.frames)) {
    const e = row.expected!;
    const time = exactTime(row.clock!, e.frames as string, e.rate as { num: number; den: number });
    const exported = toOtioTime(time);
    expect(exported).toEqual({ OTIO_SCHEMA: "RationalTime.1", value: Number(time.frames), rate: time.rate.num / time.rate.den });
    expect(Number.isSafeInteger(exported.value)).toBe(true);
    expect(toOtioRange({ start: time, duration: time })).toEqual({ OTIO_SCHEMA: "TimeRange.1", start_time: exported, duration: exported });
  }
  expect(() => toOtioTime(exactTime("source", "9007199254740992", { num: 25, den: 1 }))).toThrow("safe whole-frame range");
});

test("rows that differ from OTIO name the reason", () => {
  for (const row of table.cases) {
    if (row.expected?.timecode && row.rate?.den === 1001 && [30000, 60000].includes(row.rate.num) && row.dropFrame === false) {
      expect(row.otio?.differs, row.id).toBe(true);
      expect(row.otio?.reason, row.id).toMatch(/inferred drop-frame/);
    }
    if (row.otio?.differs) expect(row.otio.reason.length, row.id).toBeGreaterThan(10);
  }
});

test("frames cannot silently become whole milliseconds", () => {
  expect(exactSeconds(exactTime("source", "2", { num: 24000, den: 1001 }))).toBe("0.084");
});

test("ticks past 2^53 preserve every digit as a decimal string", () => {
  const time = exactTime("timeline", "900000", { num: 25, den: 1 });
  expect(deriveExact(time, false).ticks).toBe("9144576000000000");
});

test("a rate that is not reduced names the same exact frame", () => {
  expect(exactTime("reel", "24960", { num: 48000, den: 2002 }))
    .toEqual(exactTime("reel", "24960", { num: 24000, den: 1001 }));
});

test("exact clock offsets preserve rate and reject implicit resampling", () => {
  expect(offsetTime(fromMilliseconds("reel", "1"), fromMilliseconds("timeline", "2")).frames).toBe(3n);
  expect(() => offsetTime(exactTime("source", "1", { num: 25, den: 1 }), exactTime("timeline", "2", { num: 24, den: 1 }))).toThrow("same rate and unit");
  expect(() => toOtioRange({ start: fromMilliseconds("source", "1"), duration: fromMilliseconds("timeline", "2") })).toThrow("same clock");
});


test("the compatibility wrapper also requires an explicit drop-frame choice", () => {
  // An untyped caller must get the same refusal as an exact-time caller.
  expect(() => renderTimecode(0, { num: 30000, den: 1001 }, undefined as unknown as boolean)).toThrow("Drop-frame must be stated");
});


test("a high-rate frame refuses only derived seconds and keeps exact forms", () => {
  const rate = parseTimecodeRate("2000/1").rate;
  const time = exactTime("source", "1", rate);
  const forms = deriveExact(time, false);
  expect(forms).toMatchObject({ frames: "1", ticks: "127008000", timecode: "00:00:00:01", secondsDerived: true, secondsUnavailable: "No whole millisecond falls inside this frame; three-decimal derived seconds are unavailable." });
  expect(forms).not.toHaveProperty("seconds");
  expect(() => exactSeconds(time)).toThrow("three-decimal derived seconds are unavailable");
  expect(fromTicks("source", forms.ticks!, rate).frames).toBe(1n);
  expect(fromTimecode("source", forms.timecode!, rate, false).frames).toBe(1n);
  expect(deriveExact(exactTime("source", "2", rate), false)).toMatchObject({ seconds: "0.001", secondsDerived: true });
});
