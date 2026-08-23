export type HostedRunStartErrorAction =
  | { kind: "retry"; label: "Try again" }
  | { kind: "refresh"; label: "Refresh page" }
  | { kind: "contact-support"; label: "Copy support code" }
  | { kind: "choose-goal"; label: "Choose what to find"; to: "/hosted/new/intent" }
  | { kind: "reselect"; label: "Choose again"; to: "/hosted/new/intent" }
  | { kind: "upload-again"; label: "Upload recording again"; to: "/hosted/new/recording" }
  | { kind: "finish-or-discard"; label: "Finish or discard upload"; to: "/hosted/new/recording" };

export interface HostedRunStartErrorCopy {
  message: string;
  nextAction: string;
  action: HostedRunStartErrorAction;
}

const retryAction = { kind: "retry", label: "Try again" } as const;
const refreshAction = { kind: "refresh", label: "Refresh page" } as const;
const contactSupportAction = {
  kind: "contact-support",
  label: "Copy support code",
} as const;
const chooseGoalAction = {
  kind: "choose-goal",
  label: "Choose what to find",
  to: "/hosted/new/intent",
} as const;
const reselectAction = {
  kind: "reselect",
  label: "Choose again",
  to: "/hosted/new/intent",
} as const;
const uploadAgainAction = {
  kind: "upload-again",
  label: "Upload recording again",
  to: "/hosted/new/recording",
} as const;
const finishOrDiscardAction = {
  kind: "finish-or-discard",
  label: "Finish or discard upload",
  to: "/hosted/new/recording",
} as const;

const recordingUnavailableCodes = new Set([
  "hosted_media_not_found",
  "sealed_media_receipt_missing",
  "sealed_media_receipt_expired",
  "media_seal_mismatch",
]);

const retentionCodes = new Set([
  "media_retention_expired",
  "media_retention_mismatch",
]);

const temporarySpendCodes = new Map<string, string>([
  ["principal_spend_cap_unavailable", "We couldn't check this account's analysis allowance."],
  ["spend_policy_unavailable", "Analysis limits are temporarily unavailable."],
  ["spend_estimate_unavailable", "We couldn't estimate this analysis yet."],
  ["spend_call_graph_unavailable", "We couldn't prepare the analysis steps."],
]);

const temporaryDispatchCodes = new Map<string, string>([
  ["hosted_workflow_dispatch_failed", "The analysis service didn't accept this start request."],
  ["hosted_workflow_dispatch_invalid", "The analysis service returned an incomplete start response."],
  ["hosted_executor_aborted", "The start request was interrupted."],
  ["hosted_attempt_create_failed", "We couldn't create this analysis."],
]);

const requestCodes = new Map<string, string>([
  ["invalid_hosted_job_request", "These analysis selections are no longer valid."],
  ["invalid_hosted_job_json", "The saved analysis request could not be read."],
  ["hosted_job_request_too_large", "The saved analysis request is too large."],
]);

const refreshCodes = new Map<string, string>([
  ["hosted_idempotency_conflict", "This start request no longer matches the saved analysis."],
  ["hosted_attempt_create_conflict", "This analysis was already started another way."],
]);

export function hostedRunStartErrorCopy(code?: string): HostedRunStartErrorCopy {
  if (code === "recipe_receipt_mismatch" || code === "recipe_not_found") {
    return {
      message: "This goal was updated.",
      nextAction: "Choose what to find again.",
      action: chooseGoalAction,
    };
  }
  if (code === "custom_recipe_staging_unavailable") {
    return {
      message: "This custom goal cannot run in Hosted Studio yet.",
      nextAction: "Choose a built-in goal instead.",
      action: chooseGoalAction,
    };
  }
  if (code === "principal_spend_cap_exceeded") {
    return {
      message: "You've used this account's analysis allowance.",
      nextAction: "Contact support with the code below to raise it.",
      action: contactSupportAction,
    };
  }
  if (code && temporarySpendCodes.has(code)) {
    return {
      message: temporarySpendCodes.get(code)!,
      nextAction: "Try starting the analysis again.",
      action: retryAction,
    };
  }
  if (code && temporaryDispatchCodes.has(code)) {
    return {
      message: temporaryDispatchCodes.get(code)!,
      nextAction: "Try starting the analysis again.",
      action: retryAction,
    };
  }
  if (code === "hosted_media_open_session_cap_exceeded") {
    return {
      message: "Another recording upload is still unfinished.",
      nextAction: "Finish or discard it before starting this analysis.",
      action: finishOrDiscardAction,
    };
  }
  if (code && requestCodes.has(code)) {
    return {
      message: requestCodes.get(code)!,
      nextAction: "Choose your analysis settings again.",
      action: reselectAction,
    };
  }
  if (code && refreshCodes.has(code)) {
    return {
      message: refreshCodes.get(code)!,
      nextAction: "Refresh this page before trying again.",
      action: refreshAction,
    };
  }
  if (code === "spend_duration_unavailable") {
    return {
      message: "We couldn't read this recording's length.",
      nextAction: "Upload the recording again.",
      action: uploadAgainAction,
    };
  }
  if (code && recordingUnavailableCodes.has(code)) {
    return {
      message: "This recording is no longer ready.",
      nextAction: "Upload the recording again.",
      action: uploadAgainAction,
    };
  }
  if (code && retentionCodes.has(code)) {
    return {
      message: "This recording's availability changed.",
      nextAction: "Return to Recording and upload it again.",
      action: uploadAgainAction,
    };
  }
  return {
    message: "Something unexpected stopped this analysis from starting.",
    nextAction: "Contact support with the code below.",
    action: contactSupportAction,
  };
}
