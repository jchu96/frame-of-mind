import { describe, expect, it } from "vitest";
import {
  formatDerivedTranscript,
  mergeTranscriptionChunks,
  nearbyTranscript,
  offsetTranscriptionSegments,
} from "../src/services/transcript.js";
import { planTranscriptionWindows } from "../src/services/audio.js";

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

describe("chunked transcription stitching", () => {
  const segment = (start: string, end: string, text: string) => ({
    start,
    end,
    speaker: "Speaker 1",
    text,
  });

  it("shifts chunk-relative segments onto recording time", () => {
    expect(offsetTranscriptionSegments(
      [segment("00:00:05", "00:00:09", "second window")],
      585,
    )).toEqual([segment("00:09:50", "00:09:54", "second window")]);
  });

  it("returns the same segments when there is no offset", () => {
    const segments = [segment("00:00:01", "00:00:02", "first window")];
    expect(offsetTranscriptionSegments(segments, 0)).toBe(segments);
  });

  it("drops overlap segments the previous window already covered", () => {
    const merged = mergeTranscriptionChunks([
      {
        nominalStartSeconds: 0,
        segments: [
          segment("00:00:10", "00:00:14", "first"),
          segment("00:09:55", "00:09:59", "boundary sentence"),
        ],
      },
      {
        nominalStartSeconds: 600,
        segments: [
          // Re-transcribed lead-in: already owned by the previous window.
          segment("00:09:55", "00:09:59", "boundary sentence"),
          segment("00:10:04", "00:10:08", "second"),
        ],
      },
    ]);
    expect(merged.map((entry) => entry.text)).toEqual([
      "first",
      "boundary sentence",
      "second",
    ]);
  });

  it("orders merged segments by start time", () => {
    const merged = mergeTranscriptionChunks([
      { nominalStartSeconds: 600, segments: [segment("00:10:00", "00:10:02", "later")] },
      { nominalStartSeconds: 0, segments: [segment("00:00:02", "00:00:04", "earlier")] },
    ]);
    expect(merged.map((entry) => entry.text)).toEqual(["earlier", "later"]);
  });

  it("formats a stitched transcript at recording time", () => {
    const merged = mergeTranscriptionChunks([
      { nominalStartSeconds: 0, segments: [segment("00:00:03", "00:00:06", "opening")] },
      {
        nominalStartSeconds: 600,
        segments: offsetTranscriptionSegments([segment("00:00:20", "00:00:24", "closing")], 585),
      },
    ]);
    expect(formatDerivedTranscript(merged)).toBe(
      "[00:00:03] Speaker 1: opening\n[00:10:05] Speaker 1: closing",
    );
  });
});

describe("planTranscriptionWindows", () => {
  it("keeps a short recording in one window", () => {
    expect(planTranscriptionWindows(420, 600, 15)).toEqual([
      { startSeconds: 0, durationSeconds: 420, nominalStartSeconds: 0 },
    ]);
  });

  it("splits a long recording with a lead-in overlap after the first window", () => {
    expect(planTranscriptionWindows(1500, 600, 15)).toEqual([
      { startSeconds: 0, durationSeconds: 600, nominalStartSeconds: 0 },
      { startSeconds: 585, durationSeconds: 615, nominalStartSeconds: 600 },
      { startSeconds: 1185, durationSeconds: 315, nominalStartSeconds: 1200 },
    ]);
  });

  it("covers the recording exactly with no gaps between nominal windows", () => {
    const windows = planTranscriptionWindows(2996, 600, 15);
    expect(windows[0]?.nominalStartSeconds).toBe(0);
    for (const [index, window] of windows.entries()) {
      if (index === 0) continue;
      const previous = windows[index - 1]!;
      expect(window.nominalStartSeconds).toBe(
        previous.nominalStartSeconds + 600,
      );
      expect(window.startSeconds).toBeLessThan(window.nominalStartSeconds);
    }
    const last = windows.at(-1)!;
    expect(last.startSeconds + last.durationSeconds).toBe(2996);
  });

  it("rejects a non-positive duration", () => {
    expect(() => planTranscriptionWindows(0, 600, 15)).toThrow();
  });
});
