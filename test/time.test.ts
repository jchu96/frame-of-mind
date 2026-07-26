import { describe, expect, it } from "vitest";
import {
  clipWindow,
  parseSignedOffset,
  parseTranscriptOffset,
  timestampToSeconds,
} from "../src/lib/time.js";

describe("timestamp helpers", () => {
  it("parses canonical timestamps and rejects malformed coordinates", () => {
    expect(timestampToSeconds("00:02:03")).toBe(123);
    expect(timestampToSeconds("01:02:03")).toBe(3723);
    expect(() => timestampToSeconds("nonsense")).toThrow(/Invalid timestamp/);
    expect(() => timestampToSeconds("00:99:00")).toThrow(/Invalid timestamp/);
  });

  it("pads a clip without crossing zero", () => {
    expect(clipWindow("00:00:04", "00:00:12")).toEqual({ start: 0, end: 20 });
  });

  it("supports signed transcript-minus-video offsets", () => {
    expect(parseSignedOffset("-00:00:30")).toBe(-30);
    expect(parseSignedOffset("01:02:03")).toBe(3723);
    expect(parseTranscriptOffset("-00:30")).toBe(-30);
  });
});
