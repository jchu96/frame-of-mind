export type { RunSummary, StoredRun, RunPage } from "../../../src/domain/run-store.js";

export interface SessionInfo {
  authMode:
    | "off"
    | "cloudflare-access"
    | "better-auth"
    | "cloudflare-access+better-auth";
  email?: string;
  principal?: true;
  accessState?: "requested" | "approved" | "revoked";
  maintainer?: true;
}
