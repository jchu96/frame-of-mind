import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext } from "@playwright/test";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { createE2EIsolation } from "../apps/web/e2e/support/isolation";
import { retryBrowserReadiness } from "./browser-readiness";
import { createE2EEnvironment } from "./e2e-environment";
import { runFixture, videoRunFixture } from "../apps/web/test/fixtures";
import { analysisDigest } from "../src/domain/integrity";

const startedAt = performance.now();
const isolation = await createE2EIsolation(
  "hosted-auth",
  process.env.FRAME_OF_MIND_E2E_TEMP_ROOT,
);
const temporaryRoot = isolation.root;
const persistRoot = isolation.persistRoot;
const configPath = join(temporaryRoot, "wrangler.jsonc");
const databaseName = isolation.databaseName;
const databaseId = isolation.databaseId;
const workerName = isolation.workerName("hosted-auth-contract");
const wranglerBin = resolve("apps/web/node_modules/wrangler/bin/wrangler.js");
const betterAuthSecret = "fixture-only-better-auth-secret-00000000000000000000";
const mailerKey = "fixture-mailer-key";
const audience = "frame-of-mind-stacked-auth-contract";
const keyId = "stacked-auth-contract-key";
const profiles = new Map([
  ["user-a@example.test", { id: "1001", login: "fixture-a", name: "Fixture A" }],
  ["user-b@example.test", { id: "1002", login: "fixture-b", name: "Fixture B" }],
  ["stacked@example.test", { id: "1003", login: "fixture-stacked", name: "Fixture Stacked" }],
  ["browser@example.test", { id: "1004", login: "fixture-browser", name: "Fixture Browser" }],
  ["unknown@example.test", { id: "1999", login: "fixture-unknown", name: "Fixture Unknown" }],
]);
const magicLinks = new Map<string, string>();
const keys = await generateKeyPair("RS256");
const publicJwk = await exportJWK(keys.publicKey);
let worker: ReturnType<typeof Bun.spawn> | undefined;
let workerOutput: Promise<[string, string]> | undefined;

const fixtureServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/cdn-cgi/access/certs") {
      return Response.json({ keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/login/oauth/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") || "");
      redirect.searchParams.set("code", `fixture:${url.searchParams.get("login_hint") || "browser@example.test"}`);
      redirect.searchParams.set("state", url.searchParams.get("state") || "");
      return Response.redirect(redirect, 302);
    }
    if (url.pathname === "/login/oauth/access_token" && request.method === "POST") {
      const body = new URLSearchParams(await request.text());
      const code = body.get("code") || "";
      if (!code.startsWith("fixture:")) return Response.json({ error: "bad_verification_code" }, { status: 400 });
      return Response.json({ access_token: `token:${code.slice(8)}`, token_type: "bearer", scope: "user:email" });
    }
    if (url.pathname === "/user") {
      const email = (request.headers.get("authorization") || "").replace(/^Bearer token:/, "");
      const profile = profiles.get(email);
      if (!profile) return Response.json({ message: "Bad credentials" }, { status: 401 });
      return Response.json({
        id: profile.id,
        login: profile.login,
        name: profile.name,
        email,
        email_verified: true,
        avatar_url: null,
      });
    }
    if (url.pathname === "/magic-link" && request.method === "POST") {
      if (request.headers.get("authorization") !== `Bearer ${mailerKey}`) {
        return new Response("forbidden", { status: 403 });
      }
      const body = await request.json() as { email?: string; url?: string };
      if (!body.email || !body.url) return new Response("invalid", { status: 400 });
      magicLinks.set(body.email, body.url);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
});
const fixtureOrigin = `http://127.0.0.1:${fixtureServer.port}`;

try {
  console.log(`HOSTED_AUTH isolation=PASS worker=${workerName} database=${databaseName}`);
  console.log("HOSTED_AUTH build=START cloudflare_module");
  await runChecked(["bun", "--no-env-file", "run", "build:web:cloudflare"], "Better Auth Cloudflare build");
  console.log("HOSTED_AUTH build=PASS cloudflare_module");

  const workerPort = await isolation.reservePort();
  const origin = `http://127.0.0.1:${workerPort}`;
  await writeConfig(configPath, origin, "better-auth", false, "binding");
  const migrationArgs = [
    "node", wranglerBin, "d1", "migrations", "apply", databaseName,
    "--local", "--config", configPath, "--persist-to", persistRoot,
  ];
  const firstMigration = await runChecked(migrationArgs, "Better Auth D1 migration");
  if (!firstMigration.includes("0006_better_auth.sql")) throw new Error("D1 omitted migration 0006_better_auth.sql.");
  const replay = await runChecked(migrationArgs, "Better Auth D1 migration replay");
  if (!/no migrations to apply/i.test(replay)) throw new Error("Better Auth migration replay was not idempotent.");
  await d1Execute(
    "INSERT INTO hosted_auth_invites (email, invited_at) VALUES "
    + "('user-a@example.test','2026-08-23T00:00:00.000Z'),"
    + "('user-b@example.test','2026-08-23T00:00:00.000Z'),"
    + "('magic@example.test','2026-08-23T00:00:00.000Z'),"
    + "('http-magic@example.test','2026-08-23T00:00:00.000Z'),"
    + "('browser@example.test','2026-08-23T00:00:00.000Z'),"
    + "('stacked@example.test','2026-08-23T00:00:00.000Z')",
    configPath,
  );
  console.log("HOSTED_AUTH migration=PASS range=0001..0006 replay=idempotent");

  ({ worker, output: workerOutput } = await startWorker(configPath, workerPort));
  await waitForWorker(origin, worker, 403);
  await runHostedSignInSpec(origin, "better-auth");
  console.log("HOSTED_AUTH sign_in_page=PASS mode=better-auth");
  const browser = await launchReadyBrowser("better-auth", origin);
  try {
    const cookieA = await githubLogin(browser, origin, "user-a@example.test");
    const cookieB = await githubLogin(browser, origin, "user-b@example.test");
    console.log("HOSTED_AUTH github=PASS fake_provider browser_session=true");

    const magicCookie = await bindingMagicLinkLogin(browser, origin, "magic@example.test");
    await expectSession(origin, magicCookie, "magic@example.test", "better-auth");

    await expectUninvitedMagicLinkDenied(browser, origin, configPath);
    console.log("HOSTED_AUTH magic_link_invite=PASS mailer_calls=0 verification_rows=0");

    await expectUnknownLoginDenied(browser, origin);
    console.log("HOSTED_AUTH membership=PASS unknown_email=EMAIL_NOT_INVITED");

    const runA = runFixture();
    runA.analysis.runId = "20260823T120001Z-better-auth-a";
    runA.manifest.runId = runA.analysis.runId;
    runA.manifest.analysisSha256 = await analysisDigest(runA.analysis);
    const runB = await videoRunFixture();
    runB.analysis.runId = "20260823T120002Z-better-auth-b";
    runB.manifest.runId = runB.analysis.runId;
    runB.manifest.analysisSha256 = await analysisDigest(runB.analysis);
    await expectStatus(importRun(origin, cookieA, runA), 201, "Better Auth principal A import");
    await expectStatus(importRun(origin, cookieB, runB), 201, "Better Auth principal B import");
    const listA = await json<{ runs: Array<{ runId: string }> }>(
      await expectStatus(authenticatedFetch(origin, "/api/runs", cookieA), 200, "Better Auth principal A list"),
    );
    const listB = await json<{ runs: Array<{ runId: string }> }>(
      await expectStatus(authenticatedFetch(origin, "/api/runs", cookieB), 200, "Better Auth principal B list"),
    );
    assertEqual(listA.runs.map((run) => run.runId), [runA.manifest.runId], "Better Auth A isolation");
    assertEqual(listB.runs.map((run) => run.runId), [runB.manifest.runId], "Better Auth B isolation");
    await expectStatus(authenticatedFetch(origin, `/api/runs/${runB.manifest.runId}`, cookieA), 404, "Better Auth foreign detail");
    console.log(`HOSTED_ACCESS principal_a=PASS own=${runA.manifest.runId} foreign_detail=404`);
    console.log(`HOSTED_ACCESS principal_b=PASS own=${runB.manifest.runId} foreign_detail=404`);
    console.log("HOSTED_AUTH principal_seam=PASS namespace=ba two_principals=true");

    await stopWorker();
    await writeConfig(configPath, origin, "better-auth", false, "http");
    ({ worker, output: workerOutput } = await startWorker(configPath, workerPort));
    await waitForWorker(origin, worker, 403);
    const httpMagicCookie = await magicLinkLogin(browser, origin, "http-magic@example.test");
    await expectSession(origin, httpMagicCookie, "http-magic@example.test", "better-auth");
    console.log("HOSTED_AUTH magic_link=PASS binding=true http=true");
  } finally {
    await browser.close();
  }
  await stopWorker();

  const stackedPort = await isolation.reservePort();
  const stackedOrigin = `http://127.0.0.1:${stackedPort}`;
  await writeConfig(configPath, stackedOrigin, "cloudflare-access+better-auth");
  ({ worker, output: workerOutput } = await startWorker(configPath, stackedPort));
  await waitForWorker(stackedOrigin, worker, 403);
  const accessSub = "stacked-access-subject";
  const accessToken = await signAccessToken(keys.privateKey, accessSub);
  const browserAccessToken = await signAccessToken(keys.privateKey, "stacked-browser-access-subject");
  const mismatchedAccessToken = await signAccessToken(keys.privateKey, "different-stacked-access-subject");
  await expectStatus(fetch(`${stackedOrigin}/api/auth/sign-in/social`, { method: "POST" }), 403, "stacked auth without Access");
  await runHostedSignInSpec(stackedOrigin, "cloudflare-access+better-auth", browserAccessToken);
  console.log("HOSTED_AUTH sign_in_page=PASS mode=cloudflare-access+better-auth");
  const stackedBrowser = await launchReadyBrowser(
    "cloudflare-access+better-auth",
    stackedOrigin,
    accessToken,
  );
  try {
    const cookie = await githubLogin(stackedBrowser, stackedOrigin, "stacked@example.test", accessToken);
    await expectSession(stackedOrigin, cookie, "stacked@example.test", "cloudflare-access+better-auth", accessToken);
    await expectStackedRebindDenied(stackedBrowser, stackedOrigin, mismatchedAccessToken);
  } finally {
    await stackedBrowser.close();
  }
  await stopWorker();
  const accessBinding = await d1Execute(
    "SELECT access_sub FROM better_auth_user WHERE email = 'stacked@example.test'",
    configPath,
  );
  if (!accessBinding.includes(accessSub)) throw new Error("Stacked sign-in did not bind the Access subject.");
  console.log("HOSTED_AUTH stacked=PASS access_required=true principal=better_auth access_sub_bound=true");
  const stackedSessionCount = await d1Execute(
    "SELECT CASE WHEN COUNT(*) = 1 THEN 'STACKED_SESSION_COUNT_1' "
    + "ELSE 'STACKED_SESSION_COUNT_BAD_' || COUNT(*) END AS receipt "
    + "FROM better_auth_session AS session "
    + "JOIN better_auth_user AS user ON user.id = session.user_id "
    + "WHERE user.email = 'stacked@example.test'",
    configPath,
  );
  if (!stackedSessionCount.includes("STACKED_SESSION_COUNT_1")) {
    throw new Error(`Stacked identity mismatch created a session: ${stackedSessionCount}`);
  }
  console.log("HOSTED_AUTH stacked_rebind=PASS mismatch_denied=true");

  for (const [label, authMode] of [["unset", undefined], ["unknown", "unknown-mode"]] as const) {
    const port = await isolation.reservePort();
    const testOrigin = `http://127.0.0.1:${port}`;
    await writeConfig(configPath, testOrigin, authMode, true);
    ({ worker, output: workerOutput } = await startWorker(configPath, port));
    await waitForWorker(testOrigin, worker);
    await expectStatus(fetch(`${testOrigin}/api/hosted/jobs`), 403, `${label} hosted auth mode`);
    await expectStatus(fetch(`${testOrigin}/hosted/activity`), 403, `${label} hosted UI auth mode`);
    await stopWorker();
  }
  console.log("HOSTED_AUTH fail_closed=PASS hosted_enabled_unset=403 unknown=403");
  console.log("HOSTED_AUTH runtime=PASS workerd_d1=true");
  console.log(`HOSTED_AUTH runtime_seconds=${((performance.now() - startedAt) / 1_000).toFixed(2)}`);
  console.log("HOSTED_AUTH_SPIKE PASSED");
} catch (error) {
  await stopWorker(true);
  console.error(`HOSTED_AUTH failure=FAIL ${error instanceof Error ? error.message : String(error)}`);
  console.error("HOSTED_AUTH_SPIKE FAILED");
  throw error;
} finally {
  await stopWorker();
  await fixtureServer.stop(true);
  await isolation.cleanup();
}

async function writeConfig(
  path: string,
  origin: string,
  authMode: string | undefined,
  hostedEnabled = false,
  mailerMode: "binding" | "http" = "http",
): Promise<void> {
  const vars: Record<string, string> = {
    NUXT_BETTER_AUTH_SECRET: betterAuthSecret,
    NUXT_BETTER_AUTH_URL: origin,
    NUXT_BETTER_AUTH_GITHUB_CLIENT_ID: "fixture-client",
    NUXT_BETTER_AUTH_GITHUB_CLIENT_SECRET: "fixture-secret",
    NUXT_BETTER_AUTH_GITHUB_TEST_ORIGIN: fixtureOrigin,
    NUXT_BETTER_AUTH_MAILER_ORIGIN: fixtureOrigin,
    NUXT_BETTER_AUTH_MAILER_KEY: mailerKey,
    NUXT_BETTER_AUTH_MAILER_FROM: "sign-in@example.test",
    NUXT_BETTER_AUTH_ALLOW_INSECURE_TEST_PROVIDERS: "true",
    NUXT_HOSTED_WORKFLOWS_ENABLED: String(hostedEnabled),
  };
  if (authMode !== undefined) vars.NUXT_AUTH_MODE = authMode;
  if (authMode === "cloudflare-access+better-auth") {
    vars.NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN = fixtureOrigin;
    vars.NUXT_CLOUDFLARE_ACCESS_AUD = audience;
    vars.NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS = "true";
  }
  await writeFile(path, JSON.stringify({
    $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
    name: workerName,
    main: resolve("apps/web/.output/server/index.mjs"),
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
    assets: { directory: resolve("apps/web/.output/public"), binding: "ASSETS" },
    d1_databases: [{
      binding: "DB",
      database_name: databaseName,
      database_id: databaseId,
      migrations_dir: resolve("apps/web/db/migrations"),
    }],
    ...(mailerMode === "binding"
      ? { send_email: [{ name: "EMAIL", allowed_destination_addresses: ["magic@example.test"] }] }
      : {}),
    vars,
  }, null, 2));
}

async function githubLogin(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  origin: string,
  email: string,
  accessToken?: string,
): Promise<string> {
  const context = await browser.newContext();
  if (accessToken) await addAccessHeader(context, origin, accessToken);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/api/health`);
    const signIn = await page.evaluate(async ({ email }) => {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", loginHint: email, callbackURL: "/api/session" }),
      });
      return { status: response.status, body: await response.json() as { url?: string } };
    }, { email });
    if (signIn.status !== 200 || !signIn.body.url) {
      throw new Error(
        `GitHub fixture did not start for ${email}: ${signIn.status} ${JSON.stringify(signIn.body)}`,
      );
    }
    const providerResponse = await fetch(signIn.body.url, { redirect: "manual" });
    const callbackURL = providerResponse.headers.get("location");
    if (providerResponse.status !== 302 || !callbackURL) {
      throw new Error(`GitHub fixture authorization failed for ${email}: ${providerResponse.status}`);
    }
    const callbackResponse = await page.goto(callbackURL);
    if (!callbackResponse || !callbackResponse.ok()) {
      const callbackBody = callbackResponse ? await callbackResponse.text() : "";
      throw new Error(
        `GitHub fixture callback failed for ${email}: ${callbackResponse?.status() ?? "no-response"} ${page.url()} ${callbackBody}`,
      );
    }
    const cookie = await cookieHeader(context, origin);
    if (!cookie) throw new Error(`GitHub fixture did not issue a session for ${email}.`);
    await expectSession(origin, cookie, email, accessToken ? "cloudflare-access+better-auth" : "better-auth", accessToken);
    return cookie;
  } finally {
    // A context that already went away must not turn a passing (or failing)
    // probe into an unrelated "browser has been closed" error.
    await context.close().catch(() => undefined);
  }
}

async function launchReadyBrowser(
  mode: "better-auth" | "cloudflare-access+better-auth",
  origin: string,
  accessToken?: string,
): Promise<Awaited<ReturnType<typeof chromium.launch>>> {
  return await retryBrowserReadiness(async (attempt) => {
    const browser = await chromium.launch({ headless: true });
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext();
      if (accessToken) await addAccessHeader(context, origin, accessToken);
      const page = await context.newPage();
      const response = await page.goto(`${origin}/api/health`);
      if (!response) throw new Error(`Browser readiness omitted a response for ${mode}.`);
      await context?.close().catch(() => undefined);
      context = undefined;
      if (!browser.isConnected()) {
        throw new Error(`Browser has been closed during readiness for ${mode}.`);
      }
      console.log(`HOSTED_AUTH browser_readiness=PASS mode=${mode} attempts=${attempt}`);
      return browser;
    } catch (error) {
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw error;
    }
  }, ({ attempt }) => {
    console.log(`HOSTED_AUTH browser_readiness=RETRY mode=${mode} attempt=${attempt}`);
  });
}

async function magicLinkLogin(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  origin: string,
  email: string,
): Promise<string> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/api/health`);
    const status = await page.evaluate(async ({ email }) => {
      const response = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name: "Magic Fixture", callbackURL: "/api/session" }),
      });
      return response.status;
    }, { email });
    if (status !== 200) throw new Error(`Magic-link fixture returned ${status}.`);
    const link = magicLinks.get(email);
    if (!link) throw new Error("Captured mailer did not receive a magic link.");
    await page.goto(link);
    const cookie = await cookieHeader(context, origin);
    if (!cookie) throw new Error("Magic-link fixture did not issue a session.");
    return cookie;
  } finally {
    // A context that already went away must not turn a passing (or failing)
    // probe into an unrelated "browser has been closed" error.
    await context.close().catch(() => undefined);
  }
}

async function bindingMagicLinkLogin(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  origin: string,
  email: string,
): Promise<string> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/api/health`);
    const status = await page.evaluate(async ({ email }) => {
      const response = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name: "Magic Fixture", callbackURL: "/api/session" }),
      });
      return response.status;
    }, { email });
    if (status !== 200) throw new Error(`Binding magic-link fixture returned ${status}.`);
    if (magicLinks.has(email)) {
      throw new Error("Binding magic-link fixture used the HTTP fallback instead of EMAIL.");
    }
    const captured = await waitForSimulatedEmail(email);
    await page.goto(captured.url);
    const cookie = await cookieHeader(context, origin);
    if (!cookie) throw new Error("Binding magic-link fixture did not issue a session.");
    return cookie;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function waitForSimulatedEmail(email: string): Promise<{ url: string }> {
  const deadline = Date.now() + 10_000;
  const emailFiles = new Bun.Glob("**/email-text/*.txt");
  while (Date.now() < deadline) {
    for await (const path of emailFiles.scan({ cwd: temporaryRoot, absolute: true, dot: true })) {
      const file = Bun.file(path);
      if (await file.exists()) {
        const text = await file.text();
        const url = text.match(/https?:\/\/\S+/)?.[0];
        if (!url || !text.includes("expires in 5 minutes")) {
          throw new Error("Simulated binding email omitted its magic link or expiry copy.");
        }
        if (email !== "magic@example.test") {
          throw new Error("Simulated binding email did not target the restricted invited address.");
        }
        return { url };
      }
    }
    await Bun.sleep(50);
  }
  throw new Error("Wrangler did not write the simulated binding email to its isolated project files.");
}

async function expectUninvitedMagicLinkDenied(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  origin: string,
  config: string,
): Promise<void> {
  const email = "unknown@example.test";
  magicLinks.delete(email);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/api/health`);
    const result = await page.evaluate(async ({ email }) => {
      const response = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name: "Unknown Magic Fixture", callbackURL: "/api/session" }),
      });
      return { status: response.status, body: await response.text() };
    }, { email });
    if (result.status !== 403 || !/EMAIL_NOT_INVITED/i.test(result.body)) {
      throw new Error(`Uninvited magic-link request was not refused safely: ${result.status} ${result.body}`);
    }
    if (magicLinks.has(email)) throw new Error("Uninvited magic-link request reached the mailer.");
    const verificationRows = await d1Execute(
      "SELECT CASE WHEN COUNT(*) = 0 THEN 'UNINVITED_MAGIC_VERIFICATION_0' "
      + "ELSE 'UNINVITED_MAGIC_VERIFICATION_BAD_' || COUNT(*) END AS receipt "
      + "FROM better_auth_verification WHERE value LIKE '%unknown@example.test%'",
      config,
    );
    if (!verificationRows.includes("UNINVITED_MAGIC_VERIFICATION_0")) {
      throw new Error(`Uninvited magic-link request wrote verification state: ${verificationRows}`);
    }
  } finally {
    // A context that already went away must not turn a passing (or failing)
    // probe into an unrelated "browser has been closed" error.
    await context.close().catch(() => undefined);
  }
}

async function expectStackedRebindDenied(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  origin: string,
  accessToken: string,
): Promise<void> {
  const context = await browser.newContext();
  await addAccessHeader(context, origin, accessToken);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/api/health`);
    const signIn = await page.evaluate(async () => {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          loginHint: "stacked@example.test",
          callbackURL: "/api/session",
        }),
      });
      return { status: response.status, body: await response.json() as { url?: string } };
    });
    if (signIn.status !== 200 || !signIn.body.url) {
      throw new Error(`Stacked rebind fixture did not start: ${signIn.status} ${JSON.stringify(signIn.body)}`);
    }
    const providerResponse = await fetch(signIn.body.url, { redirect: "manual" });
    const callbackURL = providerResponse.headers.get("location");
    if (providerResponse.status !== 302 || !callbackURL) {
      throw new Error(`Stacked rebind provider authorization failed: ${providerResponse.status}`);
    }
    const callbackResponse = await page.goto(callbackURL);
    const denialEvidence = `${page.url()} ${callbackResponse ? await callbackResponse.text() : ""}`;
    if (!/ACCESS_IDENTITY_MISMATCH/i.test(denialEvidence)) {
      throw new Error(`Stacked rebind omitted the sanitized mismatch code: ${denialEvidence}`);
    }
    const sessionCookie = (await context.cookies(origin)).find((cookie) => cookie.name.includes("session_token"));
    if (sessionCookie) throw new Error("Stacked identity mismatch received a session cookie.");
  } finally {
    // A context that already went away must not turn a passing (or failing)
    // probe into an unrelated "browser has been closed" error.
    await context.close().catch(() => undefined);
  }
}

async function expectUnknownLoginDenied(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  origin: string,
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/api/health`);
    const result = await page.evaluate(async () => {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", loginHint: "unknown@example.test", callbackURL: "/api/session" }),
      });
      return await response.json() as { url?: string };
    });
    if (!result.url) throw new Error("Unknown-email fixture did not start OAuth.");
    await page.goto(result.url);
    if (!/email_not_invited|EMAIL_NOT_INVITED/i.test(page.url())) {
      throw new Error(`Unknown email omitted the sanitized denial code: ${page.url()}`);
    }
    if (await cookieHeader(context, origin)) throw new Error("Unknown email received a session cookie.");
  } finally {
    // A context that already went away must not turn a passing (or failing)
    // probe into an unrelated "browser has been closed" error.
    await context.close().catch(() => undefined);
  }
}

async function addAccessHeader(context: BrowserContext, origin: string, token: string): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    await route.continue(new URL(request.url()).origin === origin
      ? { headers: { ...request.headers(), "cf-access-jwt-assertion": token } }
      : undefined);
  });
}

async function cookieHeader(context: BrowserContext, origin: string): Promise<string> {
  return (await context.cookies(origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function expectSession(
  origin: string,
  cookie: string,
  email: string,
  mode: string,
  accessToken?: string,
): Promise<void> {
  const headers: Record<string, string> = { cookie };
  if (accessToken) headers["cf-access-jwt-assertion"] = accessToken;
  const session = await json<Record<string, unknown>>(
    await expectStatus(fetch(`${origin}/api/session`, { headers }), 200, `${mode} display session`),
  );
  if (
    session.email !== email
    || session.authMode !== mode
    || session.principal !== true
    || "sub" in session
  ) {
    throw new Error(`${mode} display session violated the principal seam.`);
  }
}

async function signAccessToken(privateKey: KeyLike, sub: string): Promise<string> {
  return new SignJWT({ sub, email: "stacked@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(fixtureOrigin)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function authenticatedFetch(origin: string, path: string, cookie: string): Promise<Response> {
  return fetch(`${origin}${path}`, { headers: { cookie } });
}

function importRun(origin: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/api/runs`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

async function d1Execute(statement: string, config: string): Promise<string> {
  return runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", config, "--persist-to", persistRoot,
    "--command", statement,
  ], "D1 auth fixture command");
}

async function startWorker(config: string, port: number): Promise<{
  worker: ReturnType<typeof Bun.spawn>;
  output: Promise<[string, string]>;
}> {
  const child = Bun.spawn([
    "node", wranglerBin, "dev", "--local", "--config", config,
    "--persist-to", persistRoot, "--ip", "127.0.0.1", "--port", String(port),
    "--log-level", "error", "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    worker: child,
    output: Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]),
  };
}

async function stopWorker(forceOutput = false): Promise<void> {
  if (!worker) return;
  worker.kill("SIGTERM");
  await worker.exited;
  if (workerOutput) {
    const [stdout, stderr] = await workerOutput;
    if (forceOutput || (worker.exitCode && worker.exitCode !== 143)) {
      process.stderr.write(`Hosted auth workerd output:\n${sanitizeWorkerOutput(`${stdout}\n${stderr}`)}`.slice(0, 12_000));
    }
  }
  worker = undefined;
  workerOutput = undefined;
}

function sanitizeWorkerOutput(value: string): string {
  return value
    .replaceAll(/https?:\/\/\S+/g, "[url]")
    .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
}

async function waitForWorker(
  origin: string,
  child: ReturnType<typeof Bun.spawn>,
  expected?: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited before readiness (${child.exitCode}).`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (expected === undefined || response.status === expected) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for workerd at ${origin}.`);
}

async function runChecked(command: string[], label: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${label} failed (${code}):\n${stdout}\n${stderr}`);
  return `${stdout}\n${stderr}`;
}

async function runHostedSignInSpec(
  origin: string,
  mode: "better-auth" | "cloudflare-access+better-auth",
  accessToken?: string,
): Promise<void> {
  const environment = createE2EEnvironment(process.env);
  environment.FRAME_OF_MIND_HOSTED_SIGN_IN_ORIGIN = origin;
  environment.FRAME_OF_MIND_HOSTED_SIGN_IN_MODE = mode;
  if (accessToken) environment.FRAME_OF_MIND_HOSTED_SIGN_IN_ACCESS_TOKEN = accessToken;
  const child = Bun.spawn([
    "bunx", "playwright", "test", "--config", "playwright.hosted.config.ts",
  ], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`Hosted sign-in Playwright spec failed (${mode}, ${code}):\n${stdout}\n${stderr}`);
  }
}

async function expectStatus(
  responsePromise: Promise<Response> | Response,
  expected: number,
  label: string,
): Promise<Response> {
  const response = await responsePromise;
  if (response.status !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
