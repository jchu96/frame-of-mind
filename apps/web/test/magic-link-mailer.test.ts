import { describe, expect, test } from "bun:test";
import { APIError } from "better-auth/api";
import type { SendEmail } from "@cloudflare/workers-types";
import {
  CLOUDFLARE_EMAIL_ERROR_CODES,
  createMagicLinkMailer,
} from "../server/utils/magic-link-mailer";

const email = " Invited@Example.Test ";
const normalizedEmail = "invited@example.test";
const url = "https://fom.example.test/api/auth/magic-link/verify?token=fixture-token&callbackURL=%2F";

describe("magic-link mailer", () => {
  test("uses the Cloudflare binding first with normalized, dual-part content", async () => {
    const messages: unknown[] = [];
    let httpCalls = 0;
    const emailBinding = {
      async send(message: unknown) {
        messages.push(message);
        return { messageId: "fixture-message" };
      },
    } as SendEmail;
    const mailer = createMagicLinkMailer({
      emailBinding,
      httpOrigin: "https://mailer.example.test",
      httpKey: "fixture-key",
      from: "sign-in@example.test",
      fetch: async () => {
        httpCalls += 1;
        return new Response(null, { status: 204 });
      },
    });

    await mailer.send({ email, url });

    expect(httpCalls).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      to: normalizedEmail,
      from: { email: "sign-in@example.test", name: "Frame of Mind" },
      subject: "Sign in to Frame of Mind",
    });
    const serialized = JSON.stringify(messages[0]);
    expect(serialized).toContain(url.replaceAll("&", "&amp;"));
    expect((messages[0] as { text?: string }).text).toContain(url);
    expect((messages[0] as { html?: string }).html).toContain("expires in 5 minutes");
  });

  test("falls back to the HTTP mailer when the binding is absent", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const mailer = createMagicLinkMailer({
      httpOrigin: "https://mailer.example.test",
      httpKey: "fixture-key",
      from: "sign-in@example.test",
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(null, { status: 204 });
      },
    });

    await mailer.send({ email, url });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("https://mailer.example.test/magic-link");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      email: normalizedEmail,
      url,
    });
  });

  test("fails closed when the binding is present but its sender is unset", async () => {
    const logged: unknown[] = [];
    let bindingCalls = 0;
    let httpCalls = 0;
    const emailBinding = {
      async send() {
        bindingCalls += 1;
        return { messageId: "fixture-message" };
      },
    } as unknown as SendEmail;
    const mailer = createMagicLinkMailer({
      emailBinding,
      httpOrigin: "https://mailer.example.test",
      httpKey: "fixture-key",
      failureLogger: (providerCode) => logged.push(providerCode),
      fetch: async () => {
        httpCalls += 1;
        return new Response(null, { status: 204 });
      },
    });

    await expectMailerUnavailable(mailer.send({ email, url }));
    expect(bindingCalls).toBe(0);
    expect(httpCalls).toBe(0);
    expect(logged).toEqual(["E_MAILER_FROM_UNSET"]);
  });

  test("fails closed when neither delivery path is configured", async () => {
    const mailer = createMagicLinkMailer({ from: "sign-in@example.test" });
    await expectMailerUnavailable(mailer.send({ email, url }));
  });

  test("records only the binding E_ code and returns MAILER_UNAVAILABLE", async () => {
    for (const code of [
      ...CLOUDFLARE_EMAIL_ERROR_CODES,
      "E_FUTURE_PROVIDER_FAILURE",
    ]) {
      const logged: unknown[] = [];
      const emailBinding = {
        async send() {
          throw Object.assign(new Error(`sensitive ${email} ${url}`), {
            code,
            messageId: "sensitive-message-id",
          });
        },
      } as unknown as SendEmail;
      const mailer = createMagicLinkMailer({
        emailBinding,
        from: "sign-in@example.test",
        failureLogger: (providerCode) => logged.push(providerCode),
      });

      await expectMailerUnavailable(mailer.send({ email, url }));
      expect(logged).toEqual([code]);
      expect(JSON.stringify(logged)).not.toContain(normalizedEmail);
      expect(JSON.stringify(logged)).not.toContain("fixture-token");
      expect(JSON.stringify(logged)).not.toContain("sensitive-message-id");
    }
  });

  test("does not fall through to HTTP when a binding error has no safe E_ code", async () => {
    const logged: unknown[] = [];
    let httpCalls = 0;
    const emailBinding = {
      async send() {
        throw new Error(`sensitive ${email} ${url}`);
      },
    } as unknown as SendEmail;
    const mailer = createMagicLinkMailer({
      emailBinding,
      httpOrigin: "https://mailer.example.test",
      httpKey: "fixture-key",
      from: "sign-in@example.test",
      failureLogger: (providerCode) => logged.push(providerCode),
      fetch: async () => {
        httpCalls += 1;
        return new Response(null, { status: 204 });
      },
    });

    await expectMailerUnavailable(mailer.send({ email, url }));
    expect(logged).toEqual(["E_EMAIL_SEND_FAILED"]);
    expect(httpCalls).toBe(0);
  });
});

function isMailerUnavailable(error: unknown): boolean {
  if (!(error instanceof APIError)) return false;
  const body = error.body as { code?: string } | undefined;
  return error.status === "SERVICE_UNAVAILABLE" && body?.code === "MAILER_UNAVAILABLE";
}

async function expectMailerUnavailable(promise: Promise<void>): Promise<void> {
  try {
    await promise;
    throw new Error("Expected the magic-link mailer to fail closed.");
  } catch (error) {
    expect(isMailerUnavailable(error)).toBe(true);
  }
}
