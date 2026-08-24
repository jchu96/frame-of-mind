import type { SendEmail } from "@cloudflare/workers-types";
import { APIError } from "better-auth/api";

export const CLOUDFLARE_EMAIL_ERROR_CODES = [
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
] as const;

const UNKNOWN_EMAIL_ERROR_CODE = "E_EMAIL_SEND_FAILED";
const MAILER_FROM_UNSET_CODE = "E_MAILER_FROM_UNSET";
const SUBJECT = "Sign in to Frame of Mind";

export interface MagicLinkMailerOptions {
  emailBinding?: SendEmail;
  httpOrigin?: string;
  httpKey?: string;
  from?: string;
  failureLogger?: (code: string) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export interface MagicLinkMessage {
  email: string;
  url: string;
}

export interface AccessRequestMessage {
  requesterEmail: string;
  notifyEmail: string;
}

export function createMagicLinkMailer(options: MagicLinkMailerOptions): {
  send(message: MagicLinkMessage): Promise<void>;
} {
  const from = options.from?.trim() ?? "";
  const httpOrigin = options.httpOrigin?.trim() ?? "";
  const httpKey = options.httpKey?.trim() ?? "";
  const send = options.fetch ?? globalThis.fetch;

  return {
    async send({ email, url }) {
      const normalizedEmail = normalizeEmail(email);
      if (options.emailBinding) {
        if (!from) {
          await logBindingFailure(options.failureLogger, MAILER_FROM_UNSET_CODE);
          throw mailerUnavailable();
        }
        try {
          await options.emailBinding.send({
            to: normalizedEmail,
            from: { email: from, name: "Frame of Mind" },
            subject: SUBJECT,
            text: magicLinkText(url),
            html: magicLinkHtml(url),
          });
          return;
        } catch (error) {
          await logBindingFailure(options.failureLogger, bindingFailureCode(error));
          throw mailerUnavailable();
        }
      }

      if (httpOrigin && httpKey) {
        try {
          const response = await send(`${httpOrigin}/magic-link`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${httpKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ email: normalizedEmail, url }),
          });
          if (response.ok) return;
        } catch {
          // The HTTP fallback has no provider code safe enough to record.
        }
      }

      throw mailerUnavailable();
    },
  };
}

export function createAccessRequestNotifier(options: MagicLinkMailerOptions): {
  send(message: AccessRequestMessage): Promise<void>;
} {
  const from = options.from?.trim() ?? "";
  const httpOrigin = options.httpOrigin?.trim() ?? "";
  const httpKey = options.httpKey?.trim() ?? "";
  const send = options.fetch ?? globalThis.fetch;

  return {
    async send({ requesterEmail, notifyEmail }) {
      const requester = normalizeEmail(requesterEmail);
      const recipient = normalizeEmail(notifyEmail);
      const command = `bun run approve ${shellQuote(requester)}`;
      if (options.emailBinding) {
        if (!from) {
          await logBindingFailure(options.failureLogger, MAILER_FROM_UNSET_CODE);
          throw mailerUnavailable();
        }
        try {
          await options.emailBinding.send({
            to: recipient,
            from: { email: from, name: "Frame of Mind" },
            subject: "Frame of Mind access request",
            text: [
              "A person requested access to Frame of Mind.",
              "",
              `Email: ${requester}`,
              "",
              "Approve from the repository:",
              command,
            ].join("\n"),
            html: [
              "<p>A person requested access to Frame of Mind.</p>",
              `<p>Email: ${escapeHtml(requester)}</p>`,
              "<p>Approve from the repository:</p>",
              `<pre>${escapeHtml(command)}</pre>`,
            ].join(""),
          });
          return;
        } catch (error) {
          await logBindingFailure(options.failureLogger, bindingFailureCode(error));
          throw mailerUnavailable();
        }
      }

      if (httpOrigin && httpKey) {
        try {
          const response = await send(`${httpOrigin}/access-request`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${httpKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              notifyEmail: recipient,
              requesterEmail: requester,
              command,
            }),
          });
          if (response.ok) return;
        } catch {
          // The HTTP fallback has no provider code safe enough to record.
        }
      }

      throw mailerUnavailable();
    },
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function magicLinkText(url: string): string {
  return [
    "Sign in to Frame of Mind",
    "",
    "Open this one-time link to sign in:",
    url,
    "",
    "This link expires in 5 minutes.",
  ].join("\n");
}

function magicLinkHtml(url: string): string {
  const safeUrl = escapeHtml(url);
  return [
    "<p>Sign in to Frame of Mind.</p>",
    `<p><a href="${safeUrl}">Open your one-time sign-in link</a></p>`,
    "<p>This link expires in 5 minutes.</p>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character]!);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function bindingFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && /^E_[A-Z0-9_]{1,117}$/.test(code)
    ? code
    : UNKNOWN_EMAIL_ERROR_CODE;
}

async function logBindingFailure(
  logger: MagicLinkMailerOptions["failureLogger"],
  code: string,
): Promise<void> {
  if (!logger) return;
  await Promise.resolve(logger(code)).catch(() => undefined);
}

function mailerUnavailable(): APIError {
  return new APIError("SERVICE_UNAVAILABLE", {
    code: "MAILER_UNAVAILABLE",
    message: "Magic-link email is unavailable.",
  });
}
