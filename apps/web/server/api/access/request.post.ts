import { getHeader } from "h3";
import { assertTrustedJsonMutation } from "../../utils/request-security";
import {
  betterAuthDatabase,
  betterAuthEmailBinding,
} from "../../utils/better-auth";
import { createAccessRequestNotifier } from "../../utils/magic-link-mailer";

const RATE_WINDOW_SECONDS = 15 * 60;
const RATE_LIMIT = 3;

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  const applicant = event.context.frameOfMindAccessApplicant;
  if (!applicant) {
    throw createError({
      statusCode: 403,
      statusMessage: "An unapproved Better Auth session is required.",
      data: { code: "access_request_session_required" },
    });
  }

  const database = betterAuthDatabase(event);
  const existing = await database.prepare(
    "SELECT state, claimed_user_id FROM hosted_auth_invites "
    + "WHERE email = ?1 OR claimed_user_id = ?2 LIMIT 1",
  ).bind(applicant.email, applicant.userId).first<{
    state: "requested" | "approved" | "revoked";
    claimed_user_id: string | null;
  }>();
  if (existing) {
    if (existing.claimed_user_id !== null && existing.claimed_user_id !== applicant.userId) {
      throw createError({ statusCode: 403, statusMessage: "Access request identity mismatch." });
    }
    return { state: existing.state, created: false, notificationSent: false };
  }

  await reserveRequestRateLimit(event, database);
  const now = new Date().toISOString();
  const inserted = await database.prepare(
    "INSERT OR IGNORE INTO hosted_auth_invites "
    + "(email, claimed_user_id, invited_at, claimed_at, state, requested_at) "
    + "VALUES (?1, ?2, ?3, ?3, 'requested', ?3)",
  ).bind(applicant.email, applicant.userId, now).run();
  if (!inserted.success) {
    throw createError({ statusCode: 503, statusMessage: "Access request could not be recorded." });
  }
  if (inserted.meta.changes !== 1) {
    return { state: "requested" as const, created: false, notificationSent: false };
  }

  const config = useRuntimeConfig(event);
  const notifyEmail = configString(config.accessRequestNotify);
  if (!notifyEmail) {
    return { state: "requested" as const, created: true, notificationSent: false };
  }
  const allowInsecureFixtures = config.betterAuthAllowInsecureTestProviders === true;
  const notifier = createAccessRequestNotifier({
    emailBinding: betterAuthEmailBinding(event),
    httpOrigin: integrationOrigin(config.betterAuthMailerOrigin, allowInsecureFixtures),
    httpKey: configString(config.betterAuthMailerKey),
    from: configString(config.betterAuthMailerFrom),
  });
  try {
    await notifier.send({ requesterEmail: applicant.email, notifyEmail });
    return { state: "requested" as const, created: true, notificationSent: true };
  } catch {
    return { state: "requested" as const, created: true, notificationSent: false };
  }
});

async function reserveRequestRateLimit(
  event: Parameters<typeof getHeader>[0],
  database: ReturnType<typeof betterAuthDatabase>,
): Promise<void> {
  const config = useRuntimeConfig(event);
  const rawIp = getHeader(event, "cf-connecting-ip")?.trim() || "shared-no-ip";
  const key = await keyedIp(rawIp, configString(config.betterAuthSecret));
  const now = Math.floor(Date.now() / 1_000);
  const cutoff = now - RATE_WINDOW_SECONDS;
  await database.prepare(
    "DELETE FROM hosted_access_request_rate_limit WHERE window_started_at <= ?1",
  ).bind(cutoff).run();
  const row = await database.prepare(
    "INSERT INTO hosted_access_request_rate_limit (key, window_started_at, request_count) "
    + "VALUES (?1, ?2, 1) "
    + "ON CONFLICT(key) DO UPDATE SET "
    + "request_count = CASE WHEN window_started_at <= ?3 THEN 1 ELSE request_count + 1 END, "
    + "window_started_at = CASE WHEN window_started_at <= ?3 THEN ?2 ELSE window_started_at END "
    + "RETURNING request_count",
  ).bind(key, now, cutoff).first<{ request_count: number }>();
  if (!row || row.request_count > RATE_LIMIT) {
    throw createError({
      statusCode: 429,
      statusMessage: "Too many access requests. Try again later.",
      data: { code: "access_request_rate_limited" },
    });
  }
}

async function keyedIp(ip: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  return `access-request:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function configString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integrationOrigin(value: unknown, allowLoopback: boolean): string | undefined {
  const raw = configString(value);
  if (!raw) return undefined;
  const url = new URL(raw);
  const loopback = allowLoopback
    && url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    && url.pathname === "/";
  if (!loopback && (url.protocol !== "https:" || url.pathname !== "/")) return undefined;
  return url.origin;
}
