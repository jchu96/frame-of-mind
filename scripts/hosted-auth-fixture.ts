import { chromium } from "@playwright/test";

export type HostedContractAuthMode = "cloudflare-access" | "better-auth";

export const hostedContractAuthMode: HostedContractAuthMode =
  process.env.FRAME_OF_MIND_HOSTED_CONTRACT_AUTH_MODE === "better-auth"
    ? "better-auth"
    : "cloudflare-access";

export const fixtureBetterAuthSecret =
  "fixture-only-better-auth-secret-00000000000000000000";

interface FixtureProfile {
  id: string;
  email: string;
  name?: string;
}

export function startFakeGithub(profiles: FixtureProfile[]): {
  origin: string;
  stop(): void;
} {
  const byEmail = new Map(profiles.map((profile) => [profile.email, profile]));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/login/oauth/authorize") {
        const redirect = new URL(url.searchParams.get("redirect_uri") || "");
        redirect.searchParams.set("code", `fixture:${url.searchParams.get("login_hint") || ""}`);
        redirect.searchParams.set("state", url.searchParams.get("state") || "");
        return Response.redirect(redirect, 302);
      }
      if (url.pathname === "/login/oauth/access_token" && request.method === "POST") {
        const code = new URLSearchParams(await request.text()).get("code") || "";
        return code.startsWith("fixture:")
          ? Response.json({ access_token: `token:${code.slice(8)}`, token_type: "bearer" })
          : Response.json({ error: "bad_verification_code" }, { status: 400 });
      }
      if (url.pathname === "/user") {
        const email = (request.headers.get("authorization") || "").replace(/^Bearer token:/, "");
        const profile = byEmail.get(email);
        if (!profile) return Response.json({ message: "Bad credentials" }, { status: 401 });
        return Response.json({
          id: profile.id,
          login: `fixture-${profile.id}`,
          name: profile.name || profile.email,
          email: profile.email,
          email_verified: true,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

export function betterAuthFixtureVars(workerOrigin: string, providerOrigin: string) {
  return {
    NUXT_AUTH_MODE: "better-auth",
    NUXT_BETTER_AUTH_SECRET: fixtureBetterAuthSecret,
    NUXT_BETTER_AUTH_URL: workerOrigin,
    NUXT_BETTER_AUTH_GITHUB_CLIENT_ID: "fixture-client",
    NUXT_BETTER_AUTH_GITHUB_CLIENT_SECRET: "fixture-secret",
    NUXT_BETTER_AUTH_GITHUB_TEST_ORIGIN: providerOrigin,
    NUXT_BETTER_AUTH_ALLOW_INSECURE_TEST_PROVIDERS: "true",
  };
}

export async function betterAuthBrowserLogin(origin: string, email: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  try {
    return await loginWithBrowser(browser, origin, email);
  } finally {
    await browser.close();
  }
}

export async function betterAuthBrowserLogins(
  origin: string,
  emails: string[],
): Promise<Map<string, string>> {
  const browser = await chromium.launch({ headless: true });
  try {
    const credentials = new Map<string, string>();
    for (const email of emails) {
      credentials.set(email, await loginWithBrowser(browser, origin, email));
    }
    return credentials;
  } finally {
    await browser.close();
  }
}

async function loginWithBrowser(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  origin: string,
  email: string,
): Promise<string> {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/api/health`);
      const signIn = await page.evaluate(async (loginEmail) => {
        const response = await fetch("/api/auth/sign-in/social", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "github", loginHint: loginEmail, callbackURL: "/api/session" }),
        });
        return { status: response.status, body: await response.json() as { url?: string } };
      }, email);
      if (signIn.status !== 200 || !signIn.body.url) {
        throw new Error(`Better Auth fixture sign-in failed for ${email}: ${signIn.status}`);
      }
      const provider = await fetch(signIn.body.url, { redirect: "manual" });
      const callback = provider.headers.get("location");
      if (provider.status !== 302 || !callback) {
        throw new Error(`Fake GitHub authorization failed for ${email}: ${provider.status}`);
      }
      const callbackResponse = await page.goto(callback);
      if (!callbackResponse?.ok()) {
        throw new Error(`Better Auth callback failed for ${email}: ${callbackResponse?.status()}`);
      }
      const cookie = (await context.cookies(origin))
        .map((item) => `${item.name}=${item.value}`)
        .join("; ");
      if (!cookie) throw new Error(`Better Auth omitted the session cookie for ${email}.`);
      return cookie;
    } finally {
      await context.close();
    }
}

export function hostedAuthHeaders(
  credential: string,
  origin?: string,
): Record<string, string> {
  return {
    ...(hostedContractAuthMode === "better-auth"
      ? { cookie: credential }
      : { "cf-access-jwt-assertion": credential }),
    ...(origin ? { "content-type": "application/json", origin } : {}),
  };
}
