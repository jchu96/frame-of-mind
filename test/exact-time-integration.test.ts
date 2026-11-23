import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as exactTime from "exact-time";
import { expect, test } from "vitest";
import type { ZodType } from "zod";
import { mediaClockSchema, rateSchema, timecodeSpecSchema } from "../src/domain/media-clock.js";

function compare<T>(wrapper: ZodType<T>, validator: { parse(value: unknown): T }, value: unknown) {
  let expected: T;
  try {
    expected = validator.parse(value);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    expect(wrapper.safeParse(value)).toMatchObject({
      success: false, error: { issues: [{ code: "custom", message: `${error.code}: ${error.message}` }] },
    });
    return;
  }
  expect(wrapper.parse(value)).toEqual(expected);
}

const rates = [
  { num: 24000, den: 1001 }, { num: 30000, den: 1001 }, { num: 60000, den: 1001 },
  { num: 25, den: 1 }, { num: 60000, den: 2002 }, { num: 0, den: 1 }, { num: 25, den: 0 },
  { num: -1, den: 1 }, { num: 25, den: -1 }, { num: 23.976, den: 1 }, { num: 25, den: 1.5 },
  { num: 25, den: 1, extra: true }, { num: 2 ** 53, den: 1 }, { num: "25", den: 1 }, {}, null,
];

test("stored rates follow the release validator", () => {
  for (const rate of rates) compare(rateSchema, exactTime.rateSchema, rate);
});

test("stored timecode specs follow the release validator", () => {
  for (const rate of rates) {
    for (const dropFrame of [true, false]) {
      for (const rateOrigin of ["declared", "media"]) {
        compare(timecodeSpecSchema, exactTime.timecodeSpecSchema, { rate, dropFrame, rateOrigin });
      }
    }
  }
  const spec = { rate: rates[0], dropFrame: false, rateOrigin: "declared" };
  for (const value of [null, {}, { ...spec, extra: true }, { ...spec, dropFrame: 1 }, { ...spec, rateOrigin: "unknown" }]) {
    compare(timecodeSpecSchema, exactTime.timecodeSpecSchema, value);
  }
});

test("stored clock names follow the release validator", () => {
  for (const clock of [...exactTime.MEDIA_CLOCKS, "wall", "", null, 1, {}]) {
    compare(mediaClockSchema, exactTime.mediaClockSchema, clock);
  }
});

test("the dependency is pinned to the reviewed release tarball", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.dependencies["exact-time"]).toBe("https://github.com/jchu96/exact-time/releases/download/v0.1.3/exact-time-0.1.3.tgz");
});

test("the published case table matches the installed release byte for byte", () => {
  const entry = createRequire(import.meta.url).resolve("exact-time");
  const release = readFileSync(join(dirname(entry), "time-cases.json"));
  const published = readFileSync(new URL("../docs/contracts/time-cases.json", import.meta.url));
  expect(published.equals(release)).toBe(true);
});
