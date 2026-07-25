import { describe, expect, it } from "vitest";
import { validateBluedotMediaUrl } from "../src/lib/files.js";

describe("validateBluedotMediaUrl", () => {
  it("accepts the verified Bluedot media host over HTTPS", () => {
    expect(validateBluedotMediaUrl(
      "https://files.app.bluedothq.com/recording.webm?Signature=redacted",
    ).hostname).toBe("files.app.bluedothq.com");
  });

  it.each([
    "http://files.app.bluedothq.com/recording.webm",
    "https://127.0.0.1/recording.webm",
    "https://files.app.bluedothq.com.evil.example/recording.webm",
  ])("rejects an unsafe recording URL: %s", (url) => {
    expect(() => validateBluedotMediaUrl(url)).toThrow();
  });
});
