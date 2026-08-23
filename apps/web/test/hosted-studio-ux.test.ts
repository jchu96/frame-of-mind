import { describe, expect, test } from "bun:test";
import {
  formatRecordingBytes,
  recordingDisplayLabel,
} from "../app/studio/recording-display";
import {
  hostedMediaStatusLabel,
  hostedMediaStatusMessage,
  type HostedMediaPhase,
} from "../server-hosted/studio-ui/use-hosted-media-upload";
import { hostedRunStartErrorCopy } from "../server-hosted/studio-ui/run-start-error";

const forbiddenRecordingWords = ["principal", "receipt", "sealed", "session"];

describe("hosted Studio UX pass 3", () => {
  test("uses plain status copy for every recording phase", () => {
    const phases: HostedMediaPhase[] = [
      "idle", "restoring", "selected", "hashing", "creating",
      "open-session-choice", "reselect-required", "ready-to-resume",
      "uploading", "paused", "sealing", "sealed", "canceling",
      "abandoned", "failed",
    ];
    for (const phase of phases) {
      const copy = `${hostedMediaStatusLabel(phase)} ${hostedMediaStatusMessage(phase, {
        hashBytes: 256_000,
        progressBytes: 256_000,
        totalBytes: 954_000,
      })}`.toLowerCase();
      for (const word of forbiddenRecordingWords) {
        expect(copy).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
      }
    }
    expect(hostedMediaStatusMessage("uploading", {
      hashBytes: 0,
      progressBytes: 256_000,
      totalBytes: 954_000,
    })).toBe("Uploading — 256 KB of 954 KB");
  });

  test("maps each start failure family to a specific sentence and next action", () => {
    expect(hostedRunStartErrorCopy("principal_spend_cap_exceeded")).toEqual({
      message: "You've used this account's analysis allowance.",
      nextAction: "Contact support to raise it.",
    });
    expect(hostedRunStartErrorCopy("spend_duration_unavailable")).toEqual({
      message: "We couldn't read this recording's length.",
      nextAction: "Upload the recording again.",
    });
    expect(hostedRunStartErrorCopy("sealed_media_receipt_missing")).toEqual({
      message: "This recording is no longer ready.",
      nextAction: "Upload the recording again.",
    });
    expect(hostedRunStartErrorCopy("media_retention_expired")).toEqual({
      message: "This recording's availability changed.",
      nextAction: "Return to Recording and upload it again.",
    });
  });

  test("renders recordings with different metadata as distinct rows", () => {
    const first = recordingDisplayLabel({ durationSeconds: 20, sizeBytes: 954_357 });
    const second = recordingDisplayLabel({ durationSeconds: 37, sizeBytes: 1_200_000 });
    expect(first).toBe("Recording · 20 s · 954 KB");
    expect(second).toBe("Recording · 37 s · 1.2 MB");
    expect(first).not.toBe(second);
    expect(formatRecordingBytes(2_147_483_648)).toBe("2.1 GB");
  });
});
