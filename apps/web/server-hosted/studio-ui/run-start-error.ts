export interface HostedRunStartErrorCopy {
  message: string;
  nextAction: string;
}

const RECORDING_UNAVAILABLE_CODES = new Set([
  "hosted_media_not_found",
  "sealed_media_receipt_missing",
  "sealed_media_receipt_expired",
  "media_seal_mismatch",
]);

const RETENTION_CODES = new Set([
  "media_retention_expired",
  "media_retention_mismatch",
]);

export function hostedRunStartErrorCopy(code?: string): HostedRunStartErrorCopy {
  if (code === "recipe_receipt_mismatch" || code === "recipe_not_found") {
    return {
      message: "This goal was updated.",
      nextAction: "Choose what to find again.",
    };
  }
  if (code === "principal_spend_cap_exceeded") {
    return {
      message: "You've used this account's analysis allowance.",
      nextAction: "Contact support to raise it.",
    };
  }
  if (code === "spend_duration_unavailable") {
    return {
      message: "We couldn't read this recording's length.",
      nextAction: "Upload the recording again.",
    };
  }
  if (code && RECORDING_UNAVAILABLE_CODES.has(code)) {
    return {
      message: "This recording is no longer ready.",
      nextAction: "Upload the recording again.",
    };
  }
  if (code && RETENTION_CODES.has(code)) {
    return {
      message: "This recording's availability changed.",
      nextAction: "Return to Recording and upload it again.",
    };
  }
  return {
    message: "Analysis could not start.",
    nextAction: "Try again. If it keeps happening, contact support with the code below.",
  };
}
