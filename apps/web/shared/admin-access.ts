export type AdminAccessState = "requested" | "approved" | "revoked";

export interface AdminAccessRow {
  email: string;
  state: AdminAccessState;
  invited_at: string;
  approved_at: string | null;
}

export interface AdminAccessGroups {
  requested: AdminAccessRow[];
  approved: AdminAccessRow[];
  revoked: AdminAccessRow[];
}

export type AdminAccessAction = "approve" | "deny" | "revoke";

export interface AdminAccessActionResult {
  email: string;
  state: AdminAccessState;
  idempotent: boolean;
}

export type AdminAccessErrorCode =
  | "admin_access_email_invalid"
  | "admin_access_last_member"
  | "admin_access_list_unavailable"
  | "admin_access_member_not_found"
  | "admin_access_membership_changed"
  | "admin_access_self_revoke"
  | "admin_access_transition_invalid";

export const ADMIN_ACCESS_ERROR_SENTENCES: Record<AdminAccessErrorCode, string> = {
  admin_access_email_invalid: "The access email is invalid. (admin_access_email_invalid)",
  admin_access_last_member: "The last approved member cannot be revoked. (admin_access_last_member)",
  admin_access_list_unavailable: "The access list is temporarily unavailable. (admin_access_list_unavailable)",
  admin_access_member_not_found: "That access row no longer exists. (admin_access_member_not_found)",
  admin_access_membership_changed: "Membership changed while this action was running. Try again. (admin_access_membership_changed)",
  admin_access_self_revoke: "You cannot revoke your own access here. (admin_access_self_revoke)",
  admin_access_transition_invalid: "That access action is not valid for the current state. (admin_access_transition_invalid)",
};

export function adminAccessErrorSentence(code: unknown): string {
  return typeof code === "string" && code in ADMIN_ACCESS_ERROR_SENTENCES
    ? ADMIN_ACCESS_ERROR_SENTENCES[code as AdminAccessErrorCode]
    : "The access action could not be completed. Try again. (admin_access_unknown)";
}
