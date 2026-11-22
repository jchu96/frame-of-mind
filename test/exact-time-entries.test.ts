import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  exactSeconds, exactTime, fromMilliseconds, fromPremiereMilliseconds, modelTime,
  snapDecimalSeconds, toPremiereMilliseconds,
} from "../src/domain/exact-time.js";
import type { Case, EntryCase } from "./time-contract-oracle.js";

const table = JSON.parse(readFileSync(new URL("../docs/contracts/time-cases.json", import.meta.url), "utf8")) as {
  cases: Case[]; entryCases: EntryCase[]; rates: { num: number; den: number }[];
};
const film = { num: 24000, den: 1001 };
const at25 = { num: 25, den: 1 };

function execute(row: EntryCase) {
  if (row.op === "snapDecimalSeconds") {
    const { frames, rate, clock, unit, askedSeconds, edge, moved, movement } =
      snapDecimalSeconds(row.clock, row.input, row.rate, row.edge);
    expect({ clock, rate, unit }).toEqual({ clock: row.clock, rate: row.rate, unit: "video-frame" });
    return { frames: String(frames), askedSeconds, edge, moved,
      movement: { numerator: String(movement.numerator), denominator: String(movement.denominator) } };
  }
  if (row.op === "fromPremiereMilliseconds") {
    const time = fromPremiereMilliseconds(row.clock, row.input, row.rate);
    expect(time).toEqual(exactTime(row.clock, String(time.frames), row.rate));
    expect(toPremiereMilliseconds(time)).toBe(row.input);
    return { frames: String(time.frames) };
  }
  const time = exactTime(row.clock, row.input, row.rate);
  const milliseconds = toPremiereMilliseconds(time);
  expect(fromPremiereMilliseconds(row.clock, milliseconds, row.rate)).toEqual(time);
  return { milliseconds };
}

test.each(table.entryCases)("$id", row => {
  if (row.refused) {
    expect(() => execute(row)).toThrow(row.refused);
    expect(() => execute(row)).toThrow("Accepted forms:");
  } else {
    expect(execute(row)).toEqual(row.expected);
  }
});

test("a range may snap to an empty range", () => {
  const rate = { num: 24, den: 1 };
  const start = snapDecimalSeconds("timeline", "0.041", rate, "start");
  const end = snapDecimalSeconds("timeline", "0.042", rate, "end");
  expect(end.frames - start.frames).toBe(0n);
});

test("D1 start excludes a partial frame", () => {
  expect(snapDecimalSeconds("reel", "5.01", at25, "start").frames,
    "MISS D1: start edge included a frame before the asked time").toBe(126n);
});

test("D2 end excludes a partial frame", () => {
  expect(snapDecimalSeconds("reel", "5.01", at25, "end").frames,
    "MISS D2: end edge included a frame after the asked time").toBe(125n);
});

test("D3 callers must state a known edge", () => {
  expect(() => Reflect.apply(snapDecimalSeconds, undefined, ["source", "0", film]),
    "MISS D3: a call with no edge was accepted").toThrow("A frame edge is required");
  expect(() => Reflect.apply(snapDecimalSeconds, undefined, ["source", "0", film, "nearest"])).toThrow("Accepted forms:");
});

test("D4 digits below floating point precision still select the next boundary", () => {
  const seconds = "9007199254740992.000000000001";
  const time = snapDecimalSeconds("timeline", seconds, at25, "start");
  expect(time.frames, "MISS D4: a decimal lost precision").toBe(225179981368524801n);
  expect(time.askedSeconds).toBe(seconds);
});

test("D5 observed subtitle milliseconds recover the written frame", () => {
  for (const row of table.entryCases.filter(r => r.basis === "observed in an editing application")) {
    expect(String(fromPremiereMilliseconds(row.clock, row.input, row.rate).frames),
      "MISS D5: observed row read one frame early").toBe(row.expected!.frames);
  }
});

test("D6 an unwritten millisecond names both neighbours", () => {
  expect(() => fromPremiereMilliseconds("source", "12513", film),
    "MISS D6: a millisecond value no frame writes was accepted").toThrow("frames 300 and 301");
});

test("D7 written milliseconds recover frames across each supported rate", () => {
  for (const rate of table.rates) {
    if (rate.num > 1000 * rate.den) continue;
    let divisor = rate.num, remainder = 1000 * rate.den;
    while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
    const period = BigInt(rate.num / divisor);
    // After this many frames, the fractional millisecond pattern repeats.
    // Check one complete period, and again beyond the safe integer range.
    for (const offset of [0n, 9007199254740993n]) {
      for (let i = 0n; i < period; i++) {
        const time = exactTime("reel", String(i + offset), rate);
        expect(() => {
          const ms = toPremiereMilliseconds(time);
          expect(fromPremiereMilliseconds("reel", ms, rate)).toEqual(time);
        }, "MISS D7: write then read changed the frame").not.toThrow();
      }
    }
  }
});

test("D8 approximate observations cannot enter the decimal conversion", () => {
  const approximate = modelTime("source", "00:00:01");
  expect(() => Reflect.apply(snapDecimalSeconds, undefined, ["source", approximate, film, "instant"]),
    "MISS D8: an approximate time became exact").toThrow("Expected decimal seconds as text");
});

test("D9 existing reading seconds stay inside the frame", () => {
  for (const row of table.cases.filter(r => r.op === "frames" && r.expected?.seconds)) {
    expect(exactSeconds(exactTime(row.clock!, row.input, row.rate!)),
      "MISS D9: an existing case row changed").toBe(row.expected!.seconds);
  }
});

test("D11 movement is a signed exact difference in seconds", () => {
  for (const [edge, numerator] of [["start", 3n], ["end", -1n], ["instant", -1n]] as const) {
    const time = snapDecimalSeconds("source", "5.010", at25, edge);
    expect({ moved: time.moved, ...time.movement },
      "MISS D11: a moved edge reported as unmoved").toEqual({ moved: true, numerator, denominator: 100n });
  }
});

test("D12 both millisecond conversions refuse rates above 1000 fps", () => {
  for (const rate of [{ num: 2000, den: 1 }, { num: 1000001, den: 1000 }]) {
    const time = exactTime("source", "1", rate);
    for (const convert of [() => fromPremiereMilliseconds("source", "0", rate), () => toPremiereMilliseconds(time)]) {
      expect(convert, "MISS D12: a rate above 1000 was accepted by the millisecond door")
        .toThrow("two frames can share one whole millisecond");
    }
  }
});

test("entry points enforce text, video units and declared rates", () => {
  for (const input of [0, null, "", "-1", "+0", " 1", "1\n", "1.", ".1", "01", "1e2"]) {
    expect(() => Reflect.apply(snapDecimalSeconds, undefined, ["source", input, film, "end"])).toThrow("Accepted forms:");
  }
  for (const input of [0, "1.0", "01"]) {
    expect(() => Reflect.apply(fromPremiereMilliseconds, undefined, ["source", input, film])).toThrow("Accepted forms:");
  }
  expect(() => Reflect.apply(fromPremiereMilliseconds, undefined, ["source", "0"])).toThrow("Accepted forms:");
  expect(() => toPremiereMilliseconds(fromMilliseconds("reel", "1"))).toThrow("declared video rate");
});
