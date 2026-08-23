import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join, resolve } from "node:path";
import { createE2EEnvironment } from "../../../../scripts/e2e-environment";
import {
  createE2EIsolation,
  type E2EIsolation,
  withE2EBuildLock,
} from "./isolation";
import {
  resolvePrebuiltWebOutput,
  resolvePrebuiltWorkflowsOutput,
} from "../../../../scripts/prebuilt-artifact";

export type HostedAuthMode = "cloudflare-access" | "better-auth";

export interface HostedPrincipalSession {
  readonly mode: HostedAuthMode;
  readonly principal: "a" | "b" | "service";
  readonly headers: Record<string, string>;
}

export interface HostedHarness {
  readonly authMode: HostedAuthMode;
  readonly baseUrl: string;
  readonly workflowUrl: string;
  readonly fakeGeminiUrl: string;
  readonly fakeGitHubUrl: string;
  readonly capturedMailerUrl: string;
  readonly media: { a: string; b: string };
  readonly mail: readonly unknown[];
  session(principal: "a" | "b" | "service"): Promise<HostedPrincipalSession>;
  close(): Promise<void>;
}

export interface HostedHarnessOptions {
  readonly onMail?: (message: unknown) => void;
}

const ACCESS_AUDIENCE = "frame-of-mind-e2e-access";
const ACCESS_KEY_ID = "frame-of-mind-e2e-key";
const PRINCIPALS = {
  a: "e2e-hosted-principal-a",
  b: "e2e-hosted-principal-b",
} as const;
const PRINCIPAL_EMAILS = {
  a: "principal-a@example.test",
  b: "principal-b@example.test",
} as const;

export function hasBetterAuthSupport(): boolean {
  return existsSync(resolve("apps/web/server/utils/better-auth.ts"));
}

export async function startHostedHarness(
  authMode: HostedAuthMode,
  options: HostedHarnessOptions = {},
): Promise<HostedHarness> {
  if (authMode === "better-auth" && !hasBetterAuthSupport()) {
    throw new Error("better-auth support is absent on this base");
  }
  const parentRoot = process.env.FRAME_OF_MIND_E2E_TEMP_ROOT;
  const isolation = await createE2EIsolation(`hosted-${authMode}`, parentRoot);
  const prebuiltOutput = await resolvePrebuiltWebOutput("cloudflare_module");
  const prebuiltWorkflows = await resolvePrebuiltWorkflowsOutput();
  const wranglerBin = resolve("apps/web/node_modules/wrangler/bin/wrangler.js");
  const webConfig = join(isolation.root, "web.wrangler.jsonc");
  const workflowConfig = join(isolation.root, "workflow.wrangler.jsonc");
  const seedPath = join(isolation.root, "seed.sql");
  const workflowOutdir = join(isolation.root, "workflow-bundle");
  const workers: ChildProcess[] = [];
  const workerOutputs: Array<Promise<[string, string]>> = [];
  const servers: Server[] = [];
  const capturedMail: unknown[] = [];
  const betterAuthSessions = new Map<"a" | "b", HostedPrincipalSession>();

  try {
    const keys = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(keys.publicKey);
    const jwks = await startFixtureServer(await isolation.reservePort(), (request, response) => {
      if (request.url !== "/cdn-cgi/access/certs") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      sendJson(response, 200, {
        keys: [{ ...publicJwk, kid: ACCESS_KEY_ID, alg: "RS256", use: "sig" }],
      });
    });
    servers.push(jwks.server);
    const issuer = `http://127.0.0.1:${jwks.port}`;

    const fakeGemini = await startFixtureServer(await isolation.reservePort(), (request, response) => {
      sendJson(response, 200, request.url === "/health"
        ? { ok: true }
        : { code: "fixture_only" });
    });
    servers.push(fakeGemini.server);

    const fakeGitHub = await startFixtureServer(await isolation.reservePort(), async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/login/oauth/authorize") {
        const callback = new URL(url.searchParams.get("redirect_uri") || "/", url);
        callback.searchParams.set("code", `fixture:${url.searchParams.get("login_hint") || ""}`);
        callback.searchParams.set("state", url.searchParams.get("state") || "fixture-state");
        response.writeHead(302, { location: callback.toString() });
        response.end();
        return;
      }
      if (url.pathname === "/login/oauth/access_token" && request.method === "POST") {
        const code = new URLSearchParams(await readRequestText(request)).get("code") || "";
        sendJson(response, 200, {
          access_token: `token:${code.replace(/^fixture:/, "")}`,
          token_type: "bearer",
          scope: "user:email",
        });
        return;
      }
      if (url.pathname === "/user") {
        const email = String(request.headers.authorization || "").replace(/^Bearer token:/, "");
        if (!/^[a-z0-9._+-]+@example\.test$/i.test(email)) {
          sendJson(response, 401, { message: "Bad credentials" });
          return;
        }
        sendJson(response, 200, {
          id: `e2e-${email.replace(/[^a-z0-9]/gi, "-")}`,
          login: `fixture-${email.split("@", 1)[0]}`,
          name: email === "tester@example.test" ? "Hosted Tester" : email,
          email,
          email_verified: true,
        });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    });
    servers.push(fakeGitHub.server);

    const mailer = await startFixtureServer(await isolation.reservePort(), async (request, response) => {
      if (request.method === "POST") {
        const message = await readRequestJson(request);
        capturedMail.push(message);
        options.onMail?.(message);
        sendJson(response, 202, { accepted: true });
        return;
      }
      sendJson(response, 200, { count: capturedMail.length });
    });
    servers.push(mailer.server);

    const webOutput = prebuiltOutput ?? join(isolation.root, "web-output");
    if (prebuiltOutput) {
      console.log("HOSTED_E2E build=SKIP prebuilt=cloudflare_module");
    } else {
      await buildHostedArtifact(webOutput);
    }

    const workflowServiceName = isolation.workerName("workflow");
    const webPort = await isolation.reservePort();
    const baseUrl = `http://127.0.0.1:${webPort}`;
    const d1Binding = {
      binding: "DB",
      database_name: isolation.databaseName,
      database_id: isolation.databaseId,
      migrations_dir: resolve("apps/web/db/migrations"),
    };
    await writeFile(webConfig, JSON.stringify({
      $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
      name: isolation.workerName("web"),
      main: join(webOutput, "server/index.mjs"),
      compatibility_date: "2026-08-18",
      compatibility_flags: ["nodejs_compat", "nodejs_als"],
      assets: { directory: join(webOutput, "public"), binding: "ASSETS" },
      d1_databases: [d1Binding],
      services: [{ binding: "HOSTED_WORKFLOWS", service: workflowServiceName }],
      vars: {
        NUXT_AUTH_MODE: authMode,
        NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN: issuer,
        NUXT_CLOUDFLARE_ACCESS_AUD: ACCESS_AUDIENCE,
        NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS: "true",
        NUXT_HOSTED_WORKFLOWS_ENABLED: "true",
        NUXT_HOSTED_SPEND_PRINCIPAL_CAP_UNITS: "1000000000",
        NUXT_HOSTED_SPEND_VIDEO_TOKENS_PER_SECOND: "300",
        NUXT_HOSTED_SPEND_PROMPT_OUTPUT_HEADROOM_PER_CALL: "100",
        NUXT_HOSTED_SPEND_MAX_INTERROGATION_CALLS: "1",
        NUXT_BETTER_AUTH_URL: baseUrl,
        NUXT_BETTER_AUTH_SECRET: "fixture-only-secret-with-at-least-thirty-two-characters",
        NUXT_BETTER_AUTH_GITHUB_CLIENT_ID: "fixture-client",
        NUXT_BETTER_AUTH_GITHUB_CLIENT_SECRET: "fixture-secret",
        NUXT_BETTER_AUTH_GITHUB_TEST_ORIGIN: `http://127.0.0.1:${fakeGitHub.port}`,
        NUXT_BETTER_AUTH_MAILER_ORIGIN: `http://127.0.0.1:${mailer.port}`,
        NUXT_BETTER_AUTH_MAILER_KEY: "fixture-mailer-key",
        NUXT_BETTER_AUTH_ALLOW_INSECURE_TEST_PROVIDERS: "true",
      },
    }, null, 2));
    await writeFile(workflowConfig, JSON.stringify({
      $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
      name: workflowServiceName,
      main: prebuiltWorkflows
        ? join(prebuiltWorkflows, "index.js")
        : resolve("apps/workflows/src/index.ts"),
      compatibility_date: "2026-08-18",
      compatibility_flags: ["nodejs_compat"],
      d1_databases: [d1Binding],
      workflows: [{
        name: isolation.workerName("analysis"),
        binding: "HOSTED_WORKFLOW",
        class_name: "HostedAnalysisWorkflow",
      }],
      vars: {
        HOSTED_FAKE_GEMINI: "true",
        HOSTED_FAKE_GEMINI_ORIGIN: `http://127.0.0.1:${fakeGemini.port}`,
      },
    }, null, 2));

    if (prebuiltWorkflows) {
      console.log("HOSTED_E2E workflow_build=SKIP prebuilt=cloudflare-workflows");
    } else {
      await runChecked(
        ["node", wranglerBin, "deploy", "--dry-run", "--config", workflowConfig, "--outdir", workflowOutdir],
        "hosted Workflow dry run",
      );
    }
    await runChecked([
      "node", wranglerBin, "d1", "migrations", "apply", isolation.databaseName,
      "--local", "--config", webConfig, "--persist-to", isolation.persistRoot,
    ], "hosted D1 migrations");
    await writeFile(seedPath, hostedSeedSql(authMode));
    await runChecked([
      "node", wranglerBin, "d1", "execute", isolation.databaseName,
      "--local", "--config", webConfig, "--persist-to", isolation.persistRoot,
      "--file", seedPath,
    ], "hosted fixture seed");

    const workflowPort = await isolation.reservePort();
    const workflowWorker = spawnWrangler(
      workflowConfig,
      isolation.persistRoot,
      workflowPort,
    );
    workers.push(workflowWorker.child);
    workerOutputs.push(workflowWorker.output);
    await waitForWorker(
      `http://127.0.0.1:${workflowPort}/health`,
      workflowWorker.child,
      200,
    );

    const webWorker = spawnWrangler(webConfig, isolation.persistRoot, webPort);
    workers.push(webWorker.child);
    workerOutputs.push(webWorker.output);
    await waitForWorker(`${baseUrl}/api/health`, webWorker.child, 403);

    const accessTokens = {
      a: await signAccessToken(keys.privateKey, issuer, {
        sub: PRINCIPALS.a,
        email: "principal-a@example.test",
      }),
      b: await signAccessToken(keys.privateKey, issuer, {
        sub: PRINCIPALS.b,
        email: "principal-b@example.test",
      }),
      service: await signAccessToken(keys.privateKey, issuer, {
        sub: "",
        common_name: "frame-of-mind-e2e.access",
      }),
    };

    return {
      authMode,
      baseUrl,
      workflowUrl: `http://127.0.0.1:${workflowPort}`,
      fakeGeminiUrl: `http://127.0.0.1:${fakeGemini.port}`,
      fakeGitHubUrl: `http://127.0.0.1:${fakeGitHub.port}`,
      capturedMailerUrl: `http://127.0.0.1:${mailer.port}`,
      media: {
        a: "media_e2e_principal_a_0001",
        b: "media_e2e_principal_b_0001",
      },
      mail: capturedMail,
      async session(principal) {
        if (authMode === "better-auth") {
          if (principal === "service") {
            throw new Error("Better Auth does not mint service principals.");
          }
          const existing = betterAuthSessions.get(principal);
          if (existing) return existing;
          const email = PRINCIPAL_EMAILS[principal];
          const cookie = await mintBetterAuthCookie(baseUrl, email);
          const principalSub = await queryBetterAuthPrincipal({
            databaseName: isolation.databaseName,
            email,
            persistRoot: isolation.persistRoot,
            webConfig,
            wranglerBin,
          });
          await runChecked([
            "node", wranglerBin, "d1", "execute", isolation.databaseName,
            "--local", "--config", webConfig, "--persist-to", isolation.persistRoot,
            "--command", hostedPrincipalSeedSql([[
              principalSub,
              email,
              principal === "a" ? "media_e2e_principal_a_0001" : "media_e2e_principal_b_0001",
            ]]),
          ], `hosted Better Auth ${principal} principal seed`);
          const session: HostedPrincipalSession = {
            mode: authMode,
            principal,
            headers: { cookie },
          };
          betterAuthSessions.set(principal, session);
          return session;
        }
        return {
          mode: authMode,
          principal,
          headers: { "cf-access-jwt-assertion": accessTokens[principal] },
        };
      },
      async close() {
        await stopHarness(workers, workerOutputs, servers, isolation);
      },
    };
  } catch (error) {
    await stopHarness(workers, workerOutputs, servers, isolation, true);
    throw error;
  }
}

function hostedSeedSql(authMode: HostedAuthMode): string {
  const accessRows = [
    [PRINCIPALS.a, "principal-a@example.test", "media_e2e_principal_a_0001"],
    [PRINCIPALS.b, "principal-b@example.test", "media_e2e_principal_b_0001"],
  ];
  return `
    ${authMode === "cloudflare-access" ? hostedPrincipalSeedSql(accessRows) : ""}
    ${authMode === "better-auth" ? `
      INSERT INTO hosted_auth_invites (email, invited_at) VALUES
        ('principal-a@example.test','${new Date().toISOString()}'),
        ('principal-b@example.test','${new Date().toISOString()}'),
        ('tester@example.test','${new Date().toISOString()}');
    ` : ""}
  `;
}

function hostedPrincipalSeedSql(rows: string[][]): string {
  const sealedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 6 * 86_400_000).toISOString();
  const digest = "a".repeat(64);
  return `
    INSERT INTO hosted_principal_spend (
      principal_sub, principal_email, cap_units, committed_units, updated_at
    ) VALUES ${rows.map(([principal, email]) =>
      `('${principal}','${email}',1000000000,0,'${sealedAt}')`
    ).join(",")};
    INSERT INTO hosted_media_receipts (
      principal_sub, media_id, gemini_file_name, gemini_file_uri, sha256,
      mime_type, retention, sealed_at, expires_at, duration_seconds, size_bytes
    ) VALUES ${rows.map(([principal, , mediaId]) =>
      `('${principal}','${mediaId}','files/${mediaId}',`
      + `'https://generativelanguage.googleapis.test/v1beta/files/${mediaId}',`
      + `'${digest}','video/mp4','retained','${sealedAt}','${expiresAt}',1,1)`
    ).join(",")};
  `;
}

async function queryBetterAuthPrincipal(options: {
  databaseName: string;
  email: string;
  persistRoot: string;
  webConfig: string;
  wranglerBin: string;
}): Promise<string> {
  const stdout = await runChecked([
    "node", options.wranglerBin, "d1", "execute", options.databaseName,
    "--local", "--config", options.webConfig, "--persist-to", options.persistRoot,
    "--command", `SELECT id FROM better_auth_user WHERE email = '${options.email}'`,
    "--json",
  ], `query Better Auth principal for ${options.email}`);
  const result = JSON.parse(stdout) as Array<{ results?: Array<{ id?: string }> }>;
  const id = result[0]?.results?.[0]?.id;
  if (!id) throw new Error(`Better Auth principal was unavailable for ${options.email}.`);
  return `ba:${id}`;
}

function spawnWrangler(config: string, persistRoot: string, port: number): {
  child: ChildProcess;
  output: Promise<[string, string]>;
} {
  const child = spawn(
    "node",
    [resolve("apps/web/node_modules/wrangler/bin/wrangler.js"),
    "dev", "--local", "--config", config, "--persist-to", persistRoot,
    "--ip", "127.0.0.1", "--port", String(port), "--log-level", "error",
    "--show-interactive-dev-session=false"],
    {
      cwd: process.cwd(),
      env: createE2EEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return {
    child,
    output: captureChildOutput(child),
  };
}

async function signAccessToken(
  privateKey: KeyLike,
  issuer: string,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: ACCESS_KEY_ID })
    .setIssuer(issuer)
    .setAudience(ACCESS_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

async function mintBetterAuthCookie(origin: string, email: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/api/health`);
      const signIn = await page.evaluate(async (loginEmail) => {
        const response = await fetch("/api/auth/sign-in/social", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "github",
            loginHint: loginEmail,
            callbackURL: "/api/session",
          }),
        });
        return {
          status: response.status,
          body: await response.json() as { url?: string },
        };
      }, email);
      if (signIn.status !== 200 || !signIn.body.url) {
        throw new Error(`Better Auth fixture sign-in failed (${signIn.status}).`);
      }
      const provider = await fetch(signIn.body.url, { redirect: "manual" });
      const callback = provider.headers.get("location");
      if (provider.status !== 302 || !callback) {
        throw new Error(`Fake GitHub authorization failed (${provider.status}).`);
      }
      const callbackResponse = await page.goto(callback);
      if (!callbackResponse?.ok()) {
        throw new Error(`Better Auth callback failed (${callbackResponse?.status()}).`);
      }
      const cookie = (await context.cookies(origin))
        .map((item) => `${item.name}=${item.value}`)
        .join("; ");
      if (!cookie) throw new Error("Better Auth omitted the fixture session cookie.");
      return cookie;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function runChecked(
  command: string[],
  label: string,
  additions: Record<string, string> = {},
): Promise<string> {
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env, additions),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr] = await captureChildOutput(child);
  const exitCode = child.exitCode;
  if (exitCode !== 0) {
    throw new Error(`${label} failed (${exitCode}):\n${stdout}\n${stderr}`.slice(0, 20_000));
  }
  return stdout;
}

async function waitForWorker(
  url: string,
  child: ChildProcess,
  expectedStatus: number,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status === expectedStatus) return;
    } catch {
      // workerd is still starting.
    }
    await delay(100);
  }
  throw new Error(`Worker did not become ready at ${url}.`);
}

async function stopHarness(
  workers: ChildProcess[],
  outputs: Array<Promise<[string, string]>>,
  servers: Server[],
  isolation: E2EIsolation,
  reportOutput = false,
): Promise<void> {
  for (const worker of workers) {
    if (worker.exitCode === null) worker.kill("SIGTERM");
  }
  await Promise.all(workers.map(waitForChildExit));
  const logs = await Promise.all(outputs);
  if (reportOutput) {
    const text = logs.flat().join("\n").trim();
    if (text) process.stderr.write(`${text.slice(0, 12_000)}\n`);
  }
  await Promise.all(servers.map(closeServer));
  await isolation.cleanup();
}

async function buildHostedArtifact(destination: string): Promise<void> {
  await withE2EBuildLock(async () => {
    await runChecked(
      ["bun", "--no-env-file", "run", "--cwd", "apps/web", "build:cloudflare"],
      "hosted Nuxt build",
      {
        FRAME_OF_MIND_STUDIO: "1",
        FRAME_OF_MIND_HOSTED_WORKFLOWS: "1",
      },
    );
    await cp(resolve("apps/web/.output"), destination, { recursive: true });
  });
}

function captureChildOutput(child: ChildProcess): Promise<[string, string]> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolveOutput, reject) => {
    child.once("error", reject);
    child.once("close", () => resolveOutput([stdout, stderr]));
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("close", () => resolveExit()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function startFixtureServer(
  port: number,
  handler: (request: IncomingMessage, response: import("node:http").ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      sendJson(response, 500, { error: String(error) });
    });
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveReady());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Fixture server did not expose a TCP port.");
  }
  return { server, port: address.port };
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const text = await readRequestText(request);
  try {
    return JSON.parse(text);
  } catch {
    return { invalid: true };
  }
}

async function readRequestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClosed, reject) => {
    server.close((error) => error ? reject(error) : resolveClosed());
  });
}
