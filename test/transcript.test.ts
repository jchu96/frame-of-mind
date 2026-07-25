import { describe, expect, it } from "vitest";
import { nearbyTranscript } from "../src/services/transcript.js";

describe("nearbyTranscript", () => {
  it("keeps only timestamped lines near an incident", () => {
    const transcript = [
      "[00:10] Pat: intro",
      "[01:00] Lee: click settings",
      "[01:20] Lee: that value is wrong",
      "[04:00] Pat: wrap up",
    ].join("\n");
    expect(nearbyTranscript(transcript, "01:10", "01:25", 20)).toContain("value is wrong");
    expect(nearbyTranscript(transcript, "01:10", "01:25", 20)).not.toContain("wrap up");
  });

  it("aligns a short video clip to a later full-meeting transcript window", () => {
    const transcript = [
      "[00:00:20] Pat: meeting introduction",
      "[01:02:52] Lee: how do I scroll back left",
      "[01:03:19] Lee: classify this by area and component",
    ].join("\n");
    const slice = nearbyTranscript(transcript, "00:08", "00:30", 15, 3_767);
    expect(slice).toContain("scroll back left");
    expect(slice).not.toContain("meeting introduction");
  });
});
