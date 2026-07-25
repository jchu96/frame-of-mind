import { describe, expect, it } from "vitest";
import {
  mimeForPath,
  safePathSegment,
  validateBluedotMediaUrl,
} from "../src/lib/files.js";

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

  it("does not treat arbitrary files as video", () => {
    expect(() => mimeForPath("/tmp/private-notes.txt")).toThrow("Unsupported recording extension");
  });

  it("keeps navigation and Windows device names out of output paths", () => {
    expect(safePathSegment("..")).toMatch(/^meeting-[a-f0-9]{12}$/);
    expect(safePathSegment("CON")).toMatch(/^meeting-[a-f0-9]{12}$/);
    expect(safePathSegment("meeting-public-test")).toBe("meeting-public-test");
  });
});
