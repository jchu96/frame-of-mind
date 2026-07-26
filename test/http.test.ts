import { describe, expect, it } from "vitest";
import {
  readResponseTextLimited,
  redactUrlForDisplay,
  ResponseTooLargeError,
} from "../src/lib/http.js";

describe("bounded response reader", () => {
  it("stops streaming once the byte limit is exceeded", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
      },
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("def"));
      },
      cancel() {
        cancelled = true;
      },
    }));
    await expect(readResponseTextLimited(response, 5)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("redacts credentials and query secrets from diagnostic URLs", () => {
    expect(redactUrlForDisplay(
      "https://user:password@mcp.example.test/service?access_token=secret#fragment",
    )).toBe("https://mcp.example.test/service");
  });
});
