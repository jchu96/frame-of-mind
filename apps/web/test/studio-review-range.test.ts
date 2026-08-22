import { describe, expect, test } from "bun:test";
import {
  parseReviewByteRange,
} from "../server-local/studio-media/review-range";

describe("Studio retained-media range parsing", () => {
  test("parses exact, open-ended, and suffix ranges", () => {
    expect(parseReviewByteRange("bytes=10-19", 100, 20)).toEqual({
      start: 10,
      end: 19,
    });
    expect(parseReviewByteRange("bytes=90-", 100, 20)).toEqual({
      start: 90,
      end: 99,
    });
    expect(parseReviewByteRange("bytes=-10", 100, 20)).toEqual({
      start: 90,
      end: 99,
    });
  });

  test("caps every satisfiable range to the response chunk bound", () => {
    expect(parseReviewByteRange("bytes=10-99", 100, 16)).toEqual({
      start: 10,
      end: 25,
    });
    expect(parseReviewByteRange("bytes=10-", 100, 16)).toEqual({
      start: 10,
      end: 25,
    });
    expect(parseReviewByteRange("bytes=-99", 100, 16)).toEqual({
      start: 84,
      end: 99,
    });
  });

  test("rejects multiple, negative, reversed, empty, and overflow ranges", () => {
    expect(parseReviewByteRange("bytes=0-1,4-5", 100)).toBeUndefined();
    expect(parseReviewByteRange("bytes=--1", 100)).toBeUndefined();
    expect(parseReviewByteRange("bytes=-0", 100)).toBeUndefined();
    expect(parseReviewByteRange("bytes=20-10", 100)).toBeUndefined();
    expect(parseReviewByteRange("bytes=", 100)).toBeUndefined();
    expect(parseReviewByteRange("bytes=999999999999999999999-", 100))
      .toBeUndefined();
    expect(parseReviewByteRange("items=0-1", 100)).toBeUndefined();
    expect(parseReviewByteRange("bytes=0-1", 0)).toBeUndefined();
  });
});
