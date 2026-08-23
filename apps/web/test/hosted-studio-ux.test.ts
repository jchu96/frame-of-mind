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
    const cases: Array<[string | undefined, string, string]> = [
      ["recipe_receipt_mismatch", "choose-goal", "This goal was updated."],
      ["recipe_not_found", "choose-goal", "This goal was updated."],
      ["principal_spend_cap_exceeded", "contact-support", "You've used this account's analysis allowance."],
      ["principal_spend_cap_unavailable", "retry", "We couldn't check this account's analysis allowance."],
      ["spend_duration_unavailable", "upload-again", "We couldn't read this recording's length."],
      ["spend_policy_unavailable", "retry", "Analysis limits are temporarily unavailable."],
      ["spend_estimate_unavailable", "retry", "We couldn't estimate this analysis yet."],
      ["spend_call_graph_unavailable", "retry", "We couldn't prepare the analysis steps."],
      ["hosted_workflow_dispatch_failed", "retry", "The analysis service didn't accept this start request."],
      ["hosted_workflow_dispatch_invalid", "retry", "The analysis service returned an incomplete start response."],
      ["hosted_executor_aborted", "retry", "The start request was interrupted."],
      ["hosted_attempt_create_failed", "retry", "We couldn't create this analysis."],
      ["hosted_media_open_session_cap_exceeded", "finish-or-discard", "Another recording upload is still unfinished."],
      ["invalid_hosted_job_request", "reselect", "These analysis selections are no longer valid."],
      ["invalid_hosted_job_json", "reselect", "The saved analysis request could not be read."],
      ["hosted_job_request_too_large", "reselect", "The saved analysis request is too large."],
      ["hosted_idempotency_conflict", "refresh", "This start request no longer matches the saved analysis."],
      ["hosted_attempt_create_conflict", "refresh", "This analysis was already started another way."],
      ["custom_recipe_staging_unavailable", "choose-goal", "This custom goal cannot run in Hosted Studio yet."],
      ["hosted_media_not_found", "upload-again", "This recording is no longer ready."],
      ["sealed_media_receipt_missing", "upload-again", "This recording is no longer ready."],
      ["sealed_media_receipt_expired", "upload-again", "This recording is no longer ready."],
      ["media_seal_mismatch", "upload-again", "This recording is no longer ready."],
      ["media_retention_expired", "upload-again", "This recording's availability changed."],
      ["media_retention_mismatch", "upload-again", "This recording's availability changed."],
      ["hosted_retained_capability_unavailable", "upload-again", "The private recording upload expired before it finished."],
      ["hosted_retained_upload_incomplete", "upload-again", "The private recording copy did not finish uploading."],
      ["hosted_retained_digest_unavailable", "upload-again", "We couldn't verify the private recording copy."],
      ["retained_media_seal_mismatch", "upload-again", "The private recording copy did not match the analyzed recording."],
      ["hosted_retained_part_size_exceeded", "upload-again", "The private recording copy exceeded the allowed size."],
      ["hosted_retained_media_in_use", "view-activity", "This private recording is still tied to active work."],
      [undefined, "contact-support", "Something unexpected stopped this analysis from starting."],
    ];
    for (const [code, expectedAction, expectedMessage] of cases) {
      const copy = hostedRunStartErrorCopy(code);
      expect(copy.message).toBe(expectedMessage);
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
