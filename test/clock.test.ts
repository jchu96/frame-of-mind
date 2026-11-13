import { describe, expect, it } from "vitest";
import { clockTime, sourceToTimeline, timelineToSource, transcriptToFile, parseSecondsMs, declareClock, parseTimecodeRate, renderTimecode } from "../src/domain/clock.js";
import { nearbyTranscript } from "../src/services/transcript.js";

import { verifyDay } from "./clock-oracle.js";

describe("ms", () => {
  it("parses exact decimal milliseconds and refuses noncanonical declarations", () => {
    expect(["0", "12.345", "3600", "86399.999"].map(parseSecondsMs)).toEqual([0, 12345, 3600000, 86399999]);
    for (const value of ["1.0005", "-1", "1e3", "12 s", "+1", "NaN", "1\n"]) expect(() => parseSecondsMs(value)).toThrow();
  });
  for (const offset of [0, 3600, 12.345]) it(`every sampled millisecond round-trips source to timeline to source exactly at offset ${offset}`, () => {
    const offsetMs = parseSecondsMs(String(offset));
    for (let ms = 0; ms < 86400000; ms += ms < 10000 || ms >= 86390000 ? 1 : Math.min(997, 86390000 - ms)) {
      const timeline = sourceToTimeline(clockTime("source", ms), offsetMs);
      if (timeline.ms !== ms + offsetMs || timelineToSource(timeline, offsetMs).ms !== ms) throw new Error(`not exact at ${ms}`);
    }
  });
});
describe("declaration", () => {
  it("an offset with four decimals is rejected before any provider call", () => expect(() => declareClock("1.0005")).toThrow());
  it("a negative offset is rejected before any provider call", () => expect(() => declareClock("-5")).toThrow());
  it("--timecode-rate without --timeline-offset is refused with the offset hint", () => expect(() => declareClock(undefined, "25")).toThrow("--timeline-offset (use 0"));
});
describe("transcript", () => {
  it("transcriptToFile matches nearbyTranscript's existing window for offset -130", () => {
    const transcript = "[00:00:00] Speaker 1: synthetic first\n[00:00:05] Speaker 1: synthetic inside\n[00:00:11] Speaker 1: synthetic after";
    const slice = nearbyTranscript(transcript, "00:02:10", "00:02:20", 0, -130);
    expect(slice).toBe(transcript.split("\n").slice(0, 2).join("\n"));
    expect(transcriptToFile(clockTime("transcript", 5000), -130).ms).toBe(135000);
  });
});
describe("rate", () => {
  it("23.98 is rejected with the accepted forms listed", () => expect(() => parseTimecodeRate("23.98")).toThrow("Accepted forms: 24, 25"));
  it("bare 29.97 is rejected until df or ndf is stated", () => {
    for (const rate of ["29.97", "59.94", "30000/1001", "60000/1001"]) expect(() => parseTimecodeRate(rate)).toThrow("Drop-frame must be stated");
    expect(parseTimecodeRate("29.97ndf").dropFrame).toBe(false);
  });
  it("aliases and rationals are exact, never rounded", () => {
    expect(parseTimecodeRate("23.976").rate).toEqual({ num: 24000, den: 1001 });
    expect(parseTimecodeRate("24000/1001").rate).toEqual({ num: 24000, den: 1001 });
    for (const value of ["29.976", "0/1", "25/0", "-25/1", "25\n", "__proto__"]) expect(() => parseTimecodeRate(value)).toThrow();
  });
});
describe("timecode", () => {
  it("29.97 DF frame 1800 renders 00:01:00;02", () => {
    const { rate, dropFrame } = parseTimecodeRate("29.97df");
    for (const [frame, expected] of [[1799, "00:00:59;29"], [1800, "00:01:00;02"], [17982, "00:10:00;00"]] as const) {
      expect(renderTimecode(Math.ceil(frame * 1000 * 1001 / 30000), rate, dropFrame)).toBe(expected);
    }
    expect(renderTimecode(60060, parseTimecodeRate("59.94df").rate, true)).toBe("00:01:00;04");
  });
  it("25df is rejected before any provider call", () => expect(() => parseTimecodeRate("25df")).toThrow());
  it("the first and last millisecond of every frame in 24 h at 24000/1001 render to that frame", () => verifyDay(parseTimecodeRate("23.976").rate));
  for (const rateName of ["24", "25", "30", "48", "50", "60", "47.952", "29.97df", "29.97ndf", "59.94df", "59.94ndf"]) {
    for (let hour = 0; hour < 24; hour += 3) it(`all frames in 24 h at ${rateName}, hours ${hour}-${hour + 3}, have exact containing-millisecond labels`, () => {
      const { rate, dropFrame } = parseTimecodeRate(rateName);
      verifyDay(rate, dropFrame, hour, hour + 3);
    });
  }
});
