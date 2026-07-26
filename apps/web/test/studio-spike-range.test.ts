import { describe, expect, it } from "bun:test";
import { parseSingleByteRange } from "../server-local/studio-spike/range";

describe("Studio byte-range spike", () => {
  it("parses bounded, open-ended, and suffix ranges", () => {
    expect(parseSingleByteRange("bytes=10-19", 100)).toEqual({
      start: 10,
      end: 19,
    });
    expect(parseSingleByteRange("bytes=90-", 100)).toEqual({
      start: 90,
      end: 99,
    });
    expect(parseSingleByteRange("bytes=-10", 100)).toEqual({
      start: 90,
      end: 99,
    });
    expect(parseSingleByteRange("bytes=90-200", 100)).toEqual({
      start: 90,
      end: 99,
    });
  });

  it("rejects multiple, reversed, empty, and unsatisfiable ranges", () => {
    expect(parseSingleByteRange("bytes=0-1,4-5", 100)).toBeUndefined();
    expect(parseSingleByteRange("bytes=20-10", 100)).toBeUndefined();
    expect(parseSingleByteRange("bytes=-0", 100)).toBeUndefined();
    expect(parseSingleByteRange("bytes=100-", 100)).toBeUndefined();
    expect(parseSingleByteRange("items=0-1", 100)).toBeUndefined();
    expect(parseSingleByteRange("bytes=0-1", 0)).toBeUndefined();
  });
});
