import { describe, expect, test } from "bun:test";
import { parseHostedByteRange } from "../server-hosted/evidence/range";
import { sha256Hex } from "../server-hosted/media/retention";

describe("hosted retained evidence primitives", () => {
  test("parses exact, open-ended, and suffix playback ranges", () => {
    expect(parseHostedByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseHostedByteRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
    expect(parseHostedByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseHostedByteRange("bytes=10-", 10)).toBeUndefined();
    expect(parseHostedByteRange("bytes=1-2,4-5", 10)).toBeUndefined();
  });

  test("hashes capability and evidence bytes with the same SHA-256 contract", async () => {
    expect(await sha256Hex("abc"))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new TextEncoder().encode("abc")))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
