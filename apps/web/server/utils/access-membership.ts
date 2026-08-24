import type {
  AdminAccessAction,
  AdminAccessState,
} from "../../shared/admin-access";

export type AccessTransitionCode =
  | "admin_access_transition_invalid"
  | "admin_access_last_member";

export class AccessTransitionError extends Error {
  constructor(readonly code: AccessTransitionCode) {
    super(code);
    this.name = "AccessTransitionError";
  }
}

export function normalizeAccessEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function parseMaintainerAllowlist(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  return new Set(value.split(",").map(normalizeAccessEmail).filter(Boolean));
}

export function isValidAccessEmail(value: string): boolean {
  return value.length <= 320
    && /^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

export function decideAccessTransition(input: {
  action: AdminAccessAction;
  currentState: AdminAccessState;
  approvedCount: number;
}): { state: AdminAccessState; idempotent: boolean } {
  const { action, currentState, approvedCount } = input;
  if (action === "approve") {
    if (currentState === "approved") return { state: currentState, idempotent: true };
    return { state: "approved", idempotent: false };
  }
  if (action === "deny") {
    if (currentState === "revoked") return { state: currentState, idempotent: true };
    if (currentState !== "requested") {
      throw new AccessTransitionError("admin_access_transition_invalid");
    }
    return { state: "revoked", idempotent: false };
  }
  if (currentState === "revoked") return { state: currentState, idempotent: true };
  if (currentState !== "approved") {
    throw new AccessTransitionError("admin_access_transition_invalid");
  }
  if (approvedCount <= 1) {
    throw new AccessTransitionError("admin_access_last_member");
  }
  return { state: "revoked", idempotent: false };
}
