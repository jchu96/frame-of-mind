import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { extractGranolaTranscript, granolaArguments } from "../src/adapters/granola-mcp.js";

describe("Granola MCP contract helpers", () => {
  it("uses an array for the plural meeting_ids contract", () => {
    const tool = {
      name: "get_meetings",
      inputSchema: {
        type: "object",
        properties: { meeting_ids: { type: "array", items: { type: "string" } } },
      },
    } as Tool;
    expect(granolaArguments(tool, "meeting-1")).toEqual({ meeting_ids: ["meeting-1"] });
  });

  it("normalizes absolute transcript times to meeting-relative timestamps", () => {
    const transcript = extractGranolaTranscript({
      transcript: [
        {
          speaker: { source: "microphone", diarization_label: "Speaker A" },
          text: "Start.",
          start_time: "2026-01-27T15:30:00Z",
        },
        {
          speaker: { source: "speaker" },
          text: "Later.",
          start_time: "2026-01-27T15:31:05Z",
        },
      ],
    });
    expect(transcript).toBe([
      "[00:00:00] Speaker A: Start.",
      "[00:01:05] speaker: Later.",
    ].join("\n"));
  });
});
