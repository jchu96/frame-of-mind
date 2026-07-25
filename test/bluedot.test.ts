import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  argumentForIdentifier,
  assertToolSucceeded,
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
});
