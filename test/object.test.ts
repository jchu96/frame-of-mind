import { describe, expect, it } from "vitest";
import { findMediaUrl } from "../src/lib/object.js";
import { normalizeToolResult } from "../src/adapters/bluedot-mcp.js";

describe("findMediaUrl", () => {
  it("prefers Bluedot originalVideoUrl over unrelated URLs", () => {
    const original = "https://files.app.bluedothq.com/a/recording.webm?Signature=secret";
    expect(findMediaUrl({
      meetingUrl: "https://app.bluedothq.com/recording/abc",
      recording: { originalVideoUrl: original },
    })).toBe(original);
  });

  it("does not interpret serialized transcript text as a media contract", () => {
    const original = "https://files.app.bluedothq.com/a/recording.webm?Expires=1";
    expect(findMediaUrl({ content: JSON.stringify({ originalVideoUrl: original }) })).toBeUndefined();
  });

  it("does not mistake an ordinary meeting page for downloadable media", () => {
    expect(findMediaUrl({ url: "https://app.bluedothq.com/recording/abc" })).toBeUndefined();
  });
});

describe("normalizeToolResult", () => {
  it("prefers structured MCP content", () => {
    expect(normalizeToolResult({
      structuredContent: { id: "meeting-1" },
      content: [{ type: "text", text: "ignored" }],
    })).toEqual({ id: "meeting-1" });
  });
});
