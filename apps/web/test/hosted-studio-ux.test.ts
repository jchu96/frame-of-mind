import { describe, expect, test } from "bun:test";
import {
  formatRecordingBytes,
  formatRetentionDuration,
  recordingDisplayLabel,
  recordingFieldHelp,
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

  test("maps every reachable start failure to specific copy and its own CTA", () => {
    const cases: Array<[string | undefined, string]> = [
      ["recipe_receipt_mismatch", "choose-goal"],
      ["recipe_not_found", "choose-goal"],
      ["principal_spend_cap_exceeded", "contact-support"],
      ["principal_spend_cap_unavailable", "retry"],
      ["spend_duration_unavailable", "upload-again"],
      ["spend_policy_unavailable", "retry"],
      ["spend_estimate_unavailable", "retry"],
      ["spend_call_graph_unavailable", "retry"],
      ["hosted_workflow_dispatch_failed", "retry"],
      ["hosted_workflow_dispatch_invalid", "retry"],
      ["hosted_executor_aborted", "retry"],
      ["hosted_attempt_create_failed", "retry"],
      ["hosted_media_open_session_cap_exceeded", "finish-or-discard"],
      ["invalid_hosted_job_request", "reselect"],
      ["invalid_hosted_job_json", "reselect"],
      ["hosted_job_request_too_large", "reselect"],
      ["hosted_idempotency_conflict", "refresh"],
      ["hosted_attempt_create_conflict", "refresh"],
      ["custom_recipe_staging_unavailable", "choose-goal"],
      ["hosted_media_not_found", "upload-again"],
      ["sealed_media_receipt_missing", "upload-again"],
      ["sealed_media_receipt_expired", "upload-again"],
      ["media_seal_mismatch", "upload-again"],
      ["media_retention_expired", "upload-again"],
      ["media_retention_mismatch", "upload-again"],
      [undefined, "contact-support"],
    ];
    for (const [code, expectedAction] of cases) {
      const copy = hostedRunStartErrorCopy(code);
      expect(copy.message).not.toBe("Analysis could not start.");
      expect(copy.message.length).toBeGreaterThan(12);
      expect(copy.nextAction.length).toBeGreaterThan(8);
      expect(copy.action.kind).toBe(expectedAction);
      expect(copy.action.label.length).toBeGreaterThan(4);
    }
    expect(hostedRunStartErrorCopy("hosted_media_open_session_cap_exceeded").message)
      .toBe("Another recording upload is still unfinished.");
    expect(hostedRunStartErrorCopy("spend_policy_unavailable").action)
      .toEqual({ kind: "retry", label: "Try again" });
  });

  test("renders recordings with different metadata as distinct rows", () => {
    const first = recordingDisplayLabel({ durationSeconds: 20, sizeBytes: 954_357 });
    const second = recordingDisplayLabel({ durationSeconds: 37, sizeBytes: 1_200_000 });
    expect(first).toBe("Recording · 20 s · 954 KB");
    expect(second).toBe("Recording · 37 s · 1.2 MB");
    expect(first).not.toBe(second);
    expect(formatRecordingBytes(2_147_483_648)).toBe("2.1 GB");
    expect(formatRetentionDuration(3_600)).toBe("1 hour");
    expect(formatRetentionDuration(7 * 24 * 3_600)).toBe("7 days");
    expect(formatRetentionDuration(0)).toBeUndefined();
    expect(recordingFieldHelp()).toBe("MP4, MOV, M4V or WebM");
    expect(recordingFieldHelp(2_000_000)).toBe("MP4, MOV, M4V or WebM, up to 2.0 MB");
  });
});
