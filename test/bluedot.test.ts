import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  argumentForIdentifier,
  assertToolSucceeded,
  normalizeBluedotCatalog,
  extractTranscript,
} from "../src/adapters/bluedot-mcp.js";

describe("Bluedot MCP contract helpers", () => {
  it("uses the verified videoId argument", () => {
    const tool = {
      name: "get_meeting",
      inputSchema: {
        type: "object",
        properties: { videoId: { type: "string" } },
        required: ["videoId"],
      },
    } as Tool;
    expect(argumentForIdentifier(tool, "video-1")).toEqual({ videoId: "video-1" });
  });

  it("rejects MCP tool errors before constructing meeting evidence", () => {
    expect(() => assertToolSucceeded(
      { isError: true },
      "Bluedot",
      "get_meeting",
    )).toThrow("Bluedot MCP tool 'get_meeting' failed");
  });

  it("preserves timestamps and speakers from verified transcription segments", () => {
    expect(extractTranscript({
      transcription: [
        { start: 65.79, end: 66.15, text: "Example phrase.", speakerTag: "Speaker A" },
        { start: 3723, end: 3724, text: "Later phrase.", speakerTag: "Speaker B" },
      ],
    })).toBe([
      "[00:01:05] Speaker A: Example phrase.",
      "[01:02:03] Speaker B: Later phrase.",
    ].join("\n"));
  });

  it("does not reinterpret transcript-adjacent metadata as spoken evidence", () => {
    expect(extractTranscript({
      transcript_status: "ready",
      transcript_export_url: "https://example.test/private",
      segment_count: 42,
      debug_events: [{ start: 1, text: "not speech" }],
    })).toBe("");
  });

  it("normalizes only bounded meeting identity from catalog results", () => {
    expect(normalizeBluedotCatalog({
      videos: [
        {
          id: "video-1",
          title: "Weekly review",
          uploadedAt: "2026-07-27T12:00:00.000Z",
          transcription: "private words",
          signedUrl: "https://private.invalid/file",
        },
        {
          videoId: "video-2",
          name: "Planning",
          dateCreated: "2026-07-26T13:00:00.000+01:00",
        },
      ],
      pageNumber: 1,
      totalPages: 2,
    }, 16)).toEqual({
      items: [
        {
          id: "video-1",
          title: "Weekly review",
          createdAt: "2026-07-27T12:00:00.000Z",
        },
        {
          id: "video-2",
          title: "Planning",
          createdAt: "2026-07-26T12:00:00.000Z",
        },
      ],
      nextCursor: "2",
    });
    expect(JSON.stringify(normalizeBluedotCatalog({
      videos: [{
        id: "video-1",
        title: "Weekly review",
        transcription: "private words",
      }],
      hasMore: false,
    }, 16))).not.toContain("private words");
  });
});
