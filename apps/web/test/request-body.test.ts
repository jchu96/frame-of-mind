import { describe, expect, test } from "bun:test";
import { readLimitedBytes, readLimitedText, RequestBodyTooLargeError } from "../server/utils/request-body";

function stream(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("limited request body reader", () => {
  test("reads a chunked UTF-8 body within the byte limit", async () => {
    expect(await readLimitedText(stream('{"message":"', "hello", '"}'), 32))
      .toBe('{"message":"hello"}');
  });

  test("counts UTF-8 bytes instead of JavaScript characters", async () => {
    await expect(readLimitedText(stream("éé"), 3)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  test("rejects chunked bodies as soon as the limit is crossed", async () => {
    await expect(readLimitedText(stream("1234", "5678"), 7)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  test("reads bounded binary evidence without text decoding", async () => {
    const bytes = await readLimitedBytes(stream("\u0000", "PNG"), 4);
    expect([...bytes]).toEqual([0, 80, 78, 71]);
  });
});
