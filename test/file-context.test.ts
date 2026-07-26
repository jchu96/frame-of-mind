import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileContextSource, parseCaptionTranscript } from "../src/adapters/file-context.js";

describe("caption transcript parsing", () => {
  it("normalizes SRT and multiline cues without retaining sequence syntax", () => {
    expect(parseCaptionTranscript([
      "1",
      "00:00:01,250 --> 00:00:03,000",
      "First line",
      "second line",
      "",
      "2",
      "01:02:03.000 --> 01:02:04.000",
      "<i>Later</i>",
    ].join("\n"))).toBe([
      "[00:00:01] First line second line",
      "[01:02:03] Later",
    ].join("\n"));
  });

  it("does not send an unrecognized JSON export wholesale as transcript", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-context-"));
    try {
      const path = join(directory, "context.json");
      await writeFile(path, JSON.stringify({
        participant_email: "private@example.test",
        signed_url: "https://example.test/file?token=secret",
      }));
      const meeting = await new FileContextSource(path).meeting("local-test");
      expect(meeting.transcript).toBe("");
      expect(meeting.raw).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
