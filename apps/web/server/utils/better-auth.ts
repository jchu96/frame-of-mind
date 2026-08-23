import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { magicLink } from "better-auth/plugins/magic-link";
import type { D1Database, SendEmail } from "@cloudflare/workers-types";
import { toWebRequest, type H3Event } from "h3";
import { getHostedRouteTelemetry } from "#frame-hosted-telemetry";
import { createMagicLinkMailer } from "./magic-link-mailer";

const INVITE_ERROR_CODE = "EMAIL_NOT_INVITED";
const MAGIC_LINK_COOLDOWN_ERROR_CODE = "MAGIC_LINK_COOLDOWN";
const MAGIC_LINK_COOLDOWN_MS = 60_000;

interface BetterAuthSession {
  user: {
    id: string;
    email: string;
  };
}

function configString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function requireLoopbackOrHttpsOrigin(value: unknown, allowLoopback: boolean): string | undefined {
  const raw = configString(value);
  if (!raw) return undefined;
  const url = new URL(raw);
  const loopback = allowLoopback
    && url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    && url.pathname === "/";
  if (!loopback && (url.protocol !== "https:" || url.pathname !== "/")) {
    throw new Error("Better Auth integration origins must be HTTPS origins.");
  }
  return url.origin;
}

function inviteDenied(): APIError {
  return new APIError("FORBIDDEN", {
    code: INVITE_ERROR_CODE,
    message: "Sign-in is not available for this email.",
  });
}

function magicLinkCooldown(): APIError {
  return new APIError("TOO_MANY_REQUESTS", {
    code: MAGIC_LINK_COOLDOWN_ERROR_CODE,
    message: "A sign-in link was sent recently. Check your inbox or try again in a minute.",
  });
}

async function invitedUserId(database: D1Database, email: string): Promise<string | null | undefined> {
  const row = await database.prepare(
    "SELECT claimed_user_id FROM hosted_auth_invites WHERE email = ?1",
  ).bind(normalizeEmail(email)).first<{ claimed_user_id: string | null }>();
  return row?.claimed_user_id;
}

async function reserveMagicLinkSend(
  database: D1Database,
  email: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  const row = await database.prepare(
    "SELECT invite.claimed_user_id, user.id AS matching_user_id "
    + "FROM hosted_auth_invites AS invite "
    + "LEFT JOIN better_auth_user AS user ON user.email = invite.email "
    + "WHERE invite.email = ?1",
  ).bind(normalized).first<{
    claimed_user_id: string | null;
    matching_user_id: string | null;
  }>();
  if (!row || (row.claimed_user_id !== null && row.claimed_user_id !== row.matching_user_id)) {
    throw inviteDenied();
  }

  const now = new Date();
  const reserved = await database.prepare(
    "UPDATE hosted_auth_invites SET last_magic_link_at = ?1 "
    + "WHERE email = ?2 "
    + "AND (last_magic_link_at IS NULL OR last_magic_link_at <= ?3) "
    + "AND (claimed_user_id IS NULL OR claimed_user_id = ("
    + "SELECT id FROM better_auth_user WHERE email = ?2))",
  ).bind(
    now.toISOString(),
    normalized,
    new Date(now.getTime() - MAGIC_LINK_COOLDOWN_MS).toISOString(),
  ).run();
  if (reserved.success && reserved.meta.changes === 1) return;

  const current = await database.prepare(
    "SELECT invite.claimed_user_id, user.id AS matching_user_id "
    + "FROM hosted_auth_invites AS invite "
    + "LEFT JOIN better_auth_user AS user ON user.email = invite.email "
    + "WHERE invite.email = ?1",
  ).bind(normalized).first<{
    claimed_user_id: string | null;
    matching_user_id: string | null;
  }>();
  if (!current || (
    current.claimed_user_id !== null
    && current.claimed_user_id !== current.matching_user_id
  )) {
    throw inviteDenied();
  }
  throw magicLinkCooldown();
}

async function requireAndClaimInvite(
  database: D1Database,
  userId: string,
  email: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  const claimed = await invitedUserId(database, normalized);
  if (claimed === undefined || (claimed !== null && claimed !== userId)) throw inviteDenied();
  const result = await database.prepare(
    "UPDATE hosted_auth_invites "
    + "SET claimed_user_id = ?1, claimed_at = COALESCE(claimed_at, ?2) "
    + "WHERE email = ?3 AND (claimed_user_id IS NULL OR claimed_user_id = ?1)",
  ).bind(userId, new Date().toISOString(), normalized).run();
  if (!result.success || result.meta.changes !== 1) throw inviteDenied();
}

async function bindAccessSubject(
  database: D1Database,
  userId: string,
  accessSub: string | undefined,
): Promise<void> {
  if (!accessSub) return;
  const result = await database.prepare(
    "UPDATE better_auth_user SET access_sub = COALESCE(access_sub, ?1) "
    + "WHERE id = ?2 AND (access_sub IS NULL OR access_sub = ?1)",
  ).bind(accessSub, userId).run();
  if (!result.success || result.meta.changes !== 1) {
    throw new APIError("FORBIDDEN", {
      code: "ACCESS_IDENTITY_MISMATCH",
      message: "The outer access identity does not match this account.",
    });
  }
}

export function createBetterAuth(event: H3Event) {
  // Nitro's Cloudflare renderer can enter middleware through an internal H3
  // request that omits the per-event platform object. The preset still
  // publishes the current Worker bindings on __env__ for that request chain.
  const nitroEnvironment = (globalThis as typeof globalThis & {
    __env__?: { DB?: D1Database; EMAIL?: SendEmail };
  }).__env__;
  const database = (event.context.cloudflare?.env.DB ?? nitroEnvironment?.DB) as
    | D1Database
    | undefined;
  if (!database) {
    throw createError({ statusCode: 503, statusMessage: "D1 binding DB is required for Better Auth." });
  }
  const config = useRuntimeConfig(event);
  const secret = configString(config.betterAuthSecret);
  if (secret.length < 32) {
    throw createError({ statusCode: 503, statusMessage: "Better Auth is not configured." });
  }
  const requestOrigin = new URL(toWebRequest(event).url).origin;
  const configuredURL = configString(config.betterAuthUrl);
  const baseURL = configuredURL || requestOrigin;
  const allowInsecureFixtures = config.betterAuthAllowInsecureTestProviders === true;
  const fakeGithubOrigin = requireLoopbackOrHttpsOrigin(
    config.betterAuthGithubTestOrigin,
    allowInsecureFixtures,
  );
  const mailerOrigin = requireLoopbackOrHttpsOrigin(
    config.betterAuthMailerOrigin,
    allowInsecureFixtures,
  );
  const mailerFrom = configString(config.betterAuthMailerFrom);
  const mailerTelemetry = getHostedRouteTelemetry(event);
  const mailer = createMagicLinkMailer({
    emailBinding: (event.context.cloudflare?.env.EMAIL ?? nitroEnvironment?.EMAIL) as
      | SendEmail
      | undefined,
    httpOrigin: mailerOrigin,
    httpKey: configString(config.betterAuthMailerKey),
    from: mailerFrom,
    failureLogger: async (code) => {
      await mailerTelemetry.emit({
        area: "access",
        outcome: "failed",
        code,
        routeClass: "better_auth_magic_link",
        status: 503,
        studioMode: "hosted",
      });
    },
  });
  const githubClientId = configString(config.betterAuthGithubClientId);
  const githubClientSecret = configString(config.betterAuthGithubClientSecret);
  const accessSub = event.context.frameOfMindAccessIdentity?.sub;

  const providerPlugins = fakeGithubOrigin
    ? [genericOAuth({
        config: [{
          providerId: "github",
          name: "GitHub",
          clientId: githubClientId || "fixture-client",
          clientSecret: githubClientSecret || "fixture-secret",
          authorizationUrl: `${fakeGithubOrigin}/login/oauth/authorize`,
          tokenUrl: `${fakeGithubOrigin}/login/oauth/access_token`,
          userInfoUrl: `${fakeGithubOrigin}/user`,
          scopes: ["user:email"],
          pkce: true,
          requireEmailVerification: true,
          accountIssuer: "https://github.com",
          mapProfileToUser: (profile) => ({
            email: String(profile.email || ""),
            name: String(profile.name || profile.login || "GitHub user"),
            emailVerified: profile.email_verified === true,
          }),
        }],
      })]
    : [];

  return betterAuth({
    appName: "Frame of Mind",
    baseURL,
    secret,
    database,
    trustedOrigins: [new URL(baseURL).origin],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/magic-link") return;
        const email = ctx.body?.email;
        if (typeof email === "string") await reserveMagicLinkSend(database, email);
      }),
    },
    user: {
      modelName: "better_auth_user",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        accessSub: {
          type: "string",
          required: false,
          input: false,
          returned: false,
          fieldName: "access_sub",
        },
      },
      validateUserInfo: async ({ user }) => {
        if (!user.email || await invitedUserId(database, user.email) === undefined) {
          return {
            error: INVITE_ERROR_CODE,
            errorDescription: "Sign-in is not available for this email.",
          };
        }
      },
    },
    session: {
      modelName: "better_auth_session",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
        strategy: "compact",
      },
    },
    account: {
      modelName: "better_auth_account",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: ["access", "token"].join("_"),
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "better_auth_verification",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      max: allowInsecureFixtures ? 1_000 : 100,
      customRules: allowInsecureFixtures
        ? { "/sign-in/social": { window: 60, max: 1_000 } }
        : { "/sign-in/magic-link": { window: 900, max: 3 } },
      modelName: "better_auth_rate_limit",
      fields: { lastRequest: "last_request" },
    },
    socialProviders: !fakeGithubOrigin && githubClientId && githubClientSecret
      ? {
          github: {
            clientId: githubClientId,
            clientSecret: githubClientSecret,
            requireEmailVerification: true,
          },
        }
      : undefined,
    plugins: [
      magicLink({
        expiresIn: 300,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await mailer.send({ email, url });
        },
      }),
      ...providerPlugins,
    ],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await database.prepare(
              "SELECT email FROM better_auth_user WHERE id = ?1",
            ).bind(session.userId).first<{ email: string }>();
            if (!user) throw inviteDenied();
            await requireAndClaimInvite(database, session.userId, user.email);
            await bindAccessSubject(database, session.userId, accessSub);
          },
        },
      },
    },
    advanced: {
      useSecureCookies: new URL(baseURL).protocol === "https:",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: new URL(baseURL).protocol === "https:",
        path: "/",
      },
    },
  });
}

export async function principalFromBetterAuthSession(event: H3Event): Promise<{
  principal: string;
  email: string;
} | undefined> {
  const auth = createBetterAuth(event);
  const session = await auth.api.getSession({ headers: toWebRequest(event).headers }) as BetterAuthSession | null;
  if (!session?.user?.id || !session.user.email) return undefined;
  return {
    principal: `ba:${session.user.id}`,
    email: normalizeEmail(session.user.email),
  };
}
