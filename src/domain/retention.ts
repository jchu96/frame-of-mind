export type UploadRetention = "provider" | "run";

export interface RetentionFlags {
  retention?: string;
  keepUpload?: boolean;
  deleteUpload?: boolean;
}

/** CLI precedence: an explicit flag (including aliases), environment, default. */
export function resolveRetention(flags: RetentionFlags = {}, environment?: string): UploadRetention {
  if (flags.keepUpload && flags.deleteUpload) {
    throw new Error("Use either --keep-upload or --delete-upload, not both.");
  }
  const alias = flags.keepUpload ? "provider" : flags.deleteUpload ? "run" : undefined;
  if (alias && flags.retention !== undefined && flags.retention !== alias) {
    throw new Error("Upload retention flags disagree.");
  }
  const value = flags.retention ?? alias ?? environment ?? "provider";
  if (value !== "provider" && value !== "run") {
    throw new Error("Upload retention must be provider or run (idle retention is for sessions only).");
  }
  return value;
}
