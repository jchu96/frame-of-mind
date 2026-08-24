import type { D1Database } from "@cloudflare/workers-types";
import type { H3Event } from "h3";
import {
  ADMIN_ACCESS_ERROR_SENTENCES,
  type AdminAccessErrorCode,
  type AdminAccessAction,
  type AdminAccessActionResult,
  type AdminAccessRow,
  type AdminAccessState,
} from "../../shared/admin-access";
import {
  AccessTransitionError,
  decideAccessTransition,
  isValidAccessEmail,
  normalizeAccessEmail,
} from "./access-membership";
import { betterAuthDatabase } from "./better-auth";
import { assertTrustedAdminJsonMutation } from "./request-security";

export const ADMIN_ACCESS_LIMIT = 500;

export function isAdminAccessPath(path: string): boolean {
  return path === "/admin/access"
    || path === "/api/admin"
    || path.startsWith("/api/admin/");
}

export function hideAdminAccessRoute(path: string): never {
  throw createError({
    statusCode: 404,
    statusMessage: `Page not found: ${path}`,
    data: { path },
  });
}

export function requireFrameOfMindMaintainer(event: H3Event): { email: string } {
  const maintainer = event.context.frameOfMindMaintainer;
  if (!maintainer) hideAdminAccessRoute(event.path.split("?", 1)[0] || event.path);
  return maintainer;
}

export async function readAdminAccessAction(
  event: H3Event,
  action: AdminAccessAction,
): Promise<AdminAccessActionResult> {
  const maintainer = requireFrameOfMindMaintainer(event);
  assertTrustedAdminJsonMutation(event);
  const body = await readBody<unknown>(event);
  const rawEmail = body && typeof body === "object" && "email" in body
    ? (body as { email?: unknown }).email
    : undefined;
  const email = typeof rawEmail === "string" ? normalizeAccessEmail(rawEmail) : "";
  if (!isValidAccessEmail(email)) {
    throw adminAccessError("admin_access_email_invalid", 422);
  }
  if (action === "revoke" && email === maintainer.email) {
    throw adminAccessError("admin_access_self_revoke", 409);
  }
  return await applyAdminAccessAction(
    betterAuthDatabase(event),
    { action, email, actionedBy: maintainer.email, actionedAt: new Date().toISOString() },
  );
}

export async function applyAdminAccessAction(
  database: D1Database,
  input: {
    action: AdminAccessAction;
    email: string;
    actionedBy: string;
    actionedAt: string;
  },
): Promise<AdminAccessActionResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [current, countRow] = await Promise.all([
      database.prepare(
        "SELECT state FROM hosted_auth_invites WHERE email = ?1 LIMIT 1",
      ).bind(input.email).first<{ state: AdminAccessState }>(),
      database.prepare(
        "SELECT COUNT(*) AS count FROM hosted_auth_invites WHERE state = 'approved'",
      ).first<{ count: number }>(),
    ]);
    if (!current) throw adminAccessError("admin_access_member_not_found", 404);
    let transition;
    try {
      transition = decideAccessTransition({
        action: input.action,
        currentState: current.state,
        approvedCount: countRow?.count ?? 0,
      });
    } catch (error) {
      if (error instanceof AccessTransitionError) throw adminAccessError(error.code, 409);
      throw error;
    }
    if (transition.idempotent) {
      return { email: input.email, state: transition.state, idempotent: true };
    }
    const updated = await database.prepare(
      "UPDATE hosted_auth_invites SET state = ?1, approved_at = ?2, "
      + "decided_by = ?3, actioned_by = ?3, actioned_at = ?4 "
      + "WHERE email = ?5 AND state = ?6 "
      + (input.action === "revoke"
        ? "AND (SELECT COUNT(*) FROM hosted_auth_invites WHERE state = 'approved') > 1 "
        : "")
      + "RETURNING state",
    ).bind(
      transition.state,
      transition.state === "approved" ? input.actionedAt : null,
      input.actionedBy,
      input.actionedAt,
      input.email,
      current.state,
    ).first<{ state: AdminAccessState }>();
    if (updated) return { email: input.email, state: updated.state, idempotent: false };
  }
  throw adminAccessError("admin_access_membership_changed", 409);
}

export async function listAdminAccess(database: D1Database): Promise<AdminAccessRow[]> {
  const result = await database.prepare(
    "SELECT email, state, invited_at, approved_at FROM hosted_auth_invites "
    + "ORDER BY CASE state WHEN 'requested' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, "
    + "COALESCE(requested_at, invited_at), email LIMIT ?1",
  ).bind(ADMIN_ACCESS_LIMIT).all<AdminAccessRow>();
  if (!result.success) throw adminAccessError("admin_access_list_unavailable", 503);
  return result.results;
}

function adminAccessError(code: AdminAccessErrorCode, statusCode: number): ReturnType<typeof createError> {
  return createError({
    statusCode,
    statusMessage: ADMIN_ACCESS_ERROR_SENTENCES[code],
    data: { code },
  });
}
