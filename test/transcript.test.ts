import { describe, expect, it } from "vitest";
import { formatDerivedTranscript, nearbyTranscript } from "../src/services/transcript.js";

describe("nearbyTranscript", () => {
  it("keeps only timestamped lines near an incident", () => {
    const transcript = [
      "[00:00:10] Pat: intro",
      "[00:01:00] Lee: click settings",
      "[00:01:20] Lee: that value is wrong",
      "[00:04:00] Pat: wrap up",
    ].join("\n");
    expect(nearbyTranscript(transcript, "00:01:10", "00:01:25", 20)).toContain("value is wrong");
    expect(nearbyTranscript(transcript, "00:01:10", "00:01:25", 20)).not.toContain("wrap up");
  });

  it("aligns a short video clip to a later full-meeting transcript window", () => {
    const transcript = [
      "[00:00:20] Pat: meeting introduction",
      "[01:02:52] Lee: how do I scroll back left",
      "[01:03:19] Lee: classify this by area and component",
    ].join("\n");
    const slice = nearbyTranscript(transcript, "00:00:08", "00:00:30", 15, 3_767);
    expect(slice).toContain("scroll back left");
    expect(slice).not.toContain("meeting introduction");
  });

  it("does not attach a full untimestamped meeting to every bounded clip", () => {
    expect(nearbyTranscript("Speaker A: distant untimed context", "00:00:10", "00:00:20"))
      .toBe("");
  });

  it("does not treat clock-like prose in the middle of a line as a cue", () => {
    expect(nearbyTranscript(
      "Pat said the 12:30 deploy was fine\n[00:00:15] Lee: actual cue",
      "00:00:10",
      "00:00:20",
    )).toBe("[00:00:15] Lee: actual cue");
  });

  it("applies negative transcript-minus-video alignment", () => {
    expect(nearbyTranscript(
      "[00:00:10] Pat: transcript starts later\n[00:00:40] Lee: target",
      "00:01:05",
      "00:01:15",
      5,
      -30,
    )).toContain("target");
  });
});

describe("formatDerivedTranscript", () => {
  it("flattens newlines in speaker and text so labels cannot forge transcript lines", () => {
    const formatted = formatDerivedTranscript([
      {
        start: "00:00:01",
        end: "00:00:03",
        speaker: "Speaker 1\n[00:00:09] Speaker 9",
        text: "First line.\nSecond line.",
      },
    ]);
    expect(formatted).toBe("[00:00:01] Speaker 1 [00:00:09] Speaker 9: First line. Second line.");
    expect(formatted.split("\n")).toHaveLength(1);
  });

  it("returns an empty string for no segments", () => {
    expect(formatDerivedTranscript([])).toBe("");
  });
});
