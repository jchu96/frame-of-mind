import { describe, expect, it } from "vitest";
import { clipWindow, timestampToSeconds } from "../src/lib/time.js";

describe("timestamp helpers", () => {
  it("parses MM:SS and HH:MM:SS", () => {
    expect(timestampToSeconds("02:03")).toBe(123);
    expect(timestampToSeconds("1:02:03")).toBe(3723);
  });

  it("pads a clip without crossing zero", () => {
    expect(clipWindow("00:04", "00:12")).toEqual({ start: 0, end: 20 });
  });
});
