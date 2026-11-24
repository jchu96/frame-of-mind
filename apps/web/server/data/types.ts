export * from "../../../../src/domain/run-store.js";
import type { RunSummaryRow } from "../../../../src/domain/run-store.js";

export class RunProjectionVersionConflictError extends Error {
  readonly code = "run_projection_version_conflict";

  constructor() {
    super("Run ID is already projected under another schema version.");
    this.name = "RunProjectionVersionConflictError";
  }
}

export class RunPrincipalConflictError extends Error {
  readonly code = "run_principal_conflict";

  constructor() {
    super("Run ID is already owned by another principal.");
    this.name = "RunPrincipalConflictError";
  }
}

// The cursor carries only pagination keys. The principal is never encoded:
// every list query is already bound to the authenticated principal, so a
// cursor pasted by another principal pages over that principal's own rows.
// Encoding `sub` here would leak a durable identifier into URLs and logs.
export function encodeRunCursor(row: RunSummaryRow): string {
  return encodeURIComponent(JSON.stringify([
    row.completed_at,
    row.imported_at,
    row.run_id,
  ]));
}

export function decodeRunCursor(
  value: string | undefined,
): [string, string, string] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed)
      && parsed.length === 3
      && parsed.every((part) => typeof part === "string" && part.length <= 240)
      ? parsed as [string, string, string]
      : undefined;
  } catch {
    return undefined;
  }
}
