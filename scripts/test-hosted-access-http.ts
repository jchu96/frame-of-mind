import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { createE2EEnvironment } from "./e2e-environment";
import { runFixture, videoRunFixture } from "../apps/web/test/fixtures";
import { analysisDigest } from "../src/domain/integrity";
import {
  betterAuthBrowserLogin,
  betterAuthFixtureVars,
  hostedAuthHeaders,
  hostedContractAuthMode,
  startFakeGithub,
} from "./hosted-auth-fixture";

const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-hosted-access-"));
const persistRoot = join(temporaryRoot, "wrangler-state");
const configPath = join(temporaryRoot, "wrangler.jsonc");
const audience = "frame-of-mind-hosted-access-contract";
const keyId = "hosted-access-contract-key";
const entrySelection = process.env.FRAME_OF_MIND_HOSTED_ACCESS_ENTRY || "index";
if (entrySelection !== "index" && entrySelection !== "hosted-entry") {
  throw new Error("FRAME_OF_MIND_HOSTED_ACCESS_ENTRY must be 'index' or 'hosted-entry'.");
}
const entryFile = entrySelection === "hosted-entry" ? "hosted-entry.mjs" : "index.mjs";
let wrangler: ReturnType<typeof Bun.spawn> | undefined;
let jwksServer: ReturnType<typeof Bun.serve> | undefined;
let fakeGithub: ReturnType<typeof startFakeGithub> | undefined;
let wranglerOutput: Promise<[string, string]> | undefined;

try {
  console.log("HOSTED_ACCESS build=START cloudflare_module");
  await runChecked(
    ["bun", "--no-env-file", "run", "build:web:cloudflare"],
    "Cloudflare artifact build",
  );
  console.log("HOSTED_ACCESS build=PASS cloudflare_module");
  if (entrySelection === "hosted-entry") {
    await runChecked(
      ["bun", "--no-env-file", "run", "build:hosted-stream-entry"],
      "Hosted wrapper entry build",
    );
  }

  const keys = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(keys.publicKey);
  jwksServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/cdn-cgi/access/certs") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }],
      });
    },
  });
  const issuer = `http://127.0.0.1:${jwksServer.port}`;
  const workerPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${workerPort}`;
  fakeGithub = hostedContractAuthMode === "better-auth"
    ? startFakeGithub([
        { id: "access-a", email: "access-a@example.test" },
        { id: "access-b", email: "access-b@example.test" },
      ])
    : undefined;

  await writeFile(configPath, JSON.stringify({
    $schema: resolve("node_modules/wrangler/config-schema.json"),
    name: "frame-of-mind-hosted-access-contract",
    main: resolve(`apps/web/.output/server/${entryFile}`),
    compatibility_date: "2026-07-02",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
    assets: {
      directory: resolve("apps/web/.output/public"),
      binding: "ASSETS",
    },
    d1_databases: [{
      binding: "DB",
      database_name: "frame-of-mind-hosted-access-contract",
      database_id: "00000000-0000-0000-0000-000000000001",
      migrations_dir: resolve("apps/web/db/migrations"),
    }],
    vars: hostedContractAuthMode === "better-auth"
      ? betterAuthFixtureVars(baseUrl, fakeGithub!.origin)
      : {
          NUXT_AUTH_MODE: "cloudflare-access",
          NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN: issuer,
          NUXT_CLOUDFLARE_ACCESS_AUD: audience,
          NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS: "true",
        },
  }, null, 2));

  const migrationArgs = [
    "bunx", "wrangler", "d1", "migrations", "apply",
    "frame-of-mind-hosted-access-contract",
    "--local",
    "--config", configPath,
    "--persist-to", persistRoot,
  ];
  await runChecked(migrationArgs, "empty D1 principal migration");
  await runChecked(migrationArgs, "idempotent D1 migration replay");
  if (hostedContractAuthMode === "better-auth") {
    await runChecked([
      "bunx", "wrangler", "d1", "execute", "frame-of-mind-hosted-access-contract",
      "--local", "--config", configPath, "--persist-to", persistRoot,
      "--command", "INSERT INTO hosted_auth_invites (email, invited_at) VALUES "
        + "('access-a@example.test','2026-08-23T00:00:00.000Z'),"
        + "('access-b@example.test','2026-08-23T00:00:00.000Z')",
    ], "Better Auth access-contract invites");
  }
  console.log("HOSTED_ACCESS migration=PASS empty_zero_sentinel replay_idempotent");

  const childEnvironment = createE2EEnvironment(process.env);
  wrangler = Bun.spawn([
    "bunx", "wrangler", "dev",
    "--local",
    "--config", configPath,
    "--persist-to", persistRoot,
    "--ip", "127.0.0.1",
    "--port", String(workerPort),
    "--log-level", "error",
    "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  wranglerOutput = Promise.all([
    new Response(wrangler.stdout).text(),
    new Response(wrangler.stderr).text(),
  ]);

  await waitForWorker(baseUrl, wrangler);

  const tokenA = hostedContractAuthMode === "better-auth"
    ? await betterAuthBrowserLogin(baseUrl, "access-a@example.test")
    : await signAccessToken(keys.privateKey, issuer, {
        sub: "hosted-user-subject-a",
        email: "recycled-seat@example.test",
      });
  const tokenB = hostedContractAuthMode === "better-auth"
    ? await betterAuthBrowserLogin(baseUrl, "access-b@example.test")
    : await signAccessToken(keys.privateKey, issuer, {
        sub: "hosted-user-subject-b",
        email: "recycled-seat@example.test",
      });
  const serviceToken = await signAccessToken(keys.privateKey, issuer, {
    sub: "",
    common_name: "hosted-contract.access",
  });

  await expectStatus(fetch(`${baseUrl}/api/runs`), 403, "missing Access assertion");
  if (hostedContractAuthMode === "cloudflare-access") {
    await expectStatus(authenticatedFetch(baseUrl, "/api/runs", serviceToken), 403, "service principal browser denial");
  }

  const runA = runFixture();
  runA.analysis.runId = "20260822T120001Z-principal-a";
  runA.manifest.runId = runA.analysis.runId;
  runA.manifest.analysisSha256 = await analysisDigest(runA.analysis);
  const runB = await videoRunFixture();
  runB.analysis.runId = "20260822T120002Z-principal-b";
  runB.manifest.runId = runB.analysis.runId;
  runB.manifest.analysisSha256 = await analysisDigest(runB.analysis);

  await expectStatus(importRun(baseUrl, tokenA, runA), 201, "principal A import");
  await expectStatus(importRun(baseUrl, tokenB, runB), 201, "principal B import");

  const listA = await json<{ runs: Array<{ runId: string }> }>(
    await expectStatus(authenticatedFetch(baseUrl, "/api/runs", tokenA), 200, "principal A list"),
  );
  const listB = await json<{ runs: Array<{ runId: string }> }>(
    await expectStatus(authenticatedFetch(baseUrl, "/api/runs", tokenB), 200, "principal B list"),
  );
  assertEqual(listA.runs.map((run) => run.runId), [runA.manifest.runId], "principal A list isolation");
  assertEqual(listB.runs.map((run) => run.runId), [runB.manifest.runId], "principal B list isolation");

  await expectStatus(
    authenticatedFetch(baseUrl, `/api/runs/${runB.manifest.runId}`, tokenA),
    404,
    "principal A detail denial",
  );
  await expectStatus(
    authenticatedFetch(baseUrl, `/api/runs/${runA.manifest.runId}`, tokenB),
    404,
    "principal B detail denial",
  );

  const conflicting = structuredClone(runA);
  const conflictResponse = await expectStatus(
    importRun(baseUrl, tokenB, conflicting),
    409,
    "cross-principal run ID conflict",
  );
  const conflictText = await conflictResponse.text();
  if (!conflictText.includes("run_principal_conflict")) {
    throw new Error("Cross-principal conflict omitted run_principal_conflict.");
  }

  const session = await json<Record<string, unknown>>(
    await expectStatus(authenticatedFetch(baseUrl, "/api/session", tokenA), 200, "display session"),
  );
  if ("principal" in session || "sub" in session) {
    throw new Error("GET /api/session exposed the durable principal.");
  }
  await expectStatus(
    authenticatedFetch(baseUrl, "/api/hosted/jobs", tokenA),
    404,
    "hosted creation remains dark",
  );

  console.log(`HOSTED_ACCESS principal_a=PASS own=${runA.manifest.runId} foreign_detail=404`);
  console.log(`HOSTED_ACCESS principal_b=PASS own=${runB.manifest.runId} foreign_detail=404`);
  console.log("HOSTED_ACCESS conflict=PASS status=409 code=run_principal_conflict");
  console.log(hostedContractAuthMode === "cloudflare-access"
    ? "HOSTED_ACCESS service=PASS status=403 browser_runs_denied"
    : "HOSTED_ACCESS service=PASS not_applicable=better_auth");
  console.log("HOSTED_ACCESS missing_header=PASS status=403");
  console.log("HOSTED_ACCESS dark=PASS hosted_creation_status=404");
  console.log(`HOSTED_ACCESS_CONTRACT PASSED entry=${entryFile}`);

  wrangler.kill("SIGTERM");
  await wrangler.exited;
  await wranglerOutput;
} catch (error) {
  if (wrangler) {
    wrangler.kill("SIGTERM");
    await wrangler.exited;
  }
  if (wranglerOutput) {
    const [stdout, stderr] = await wranglerOutput;
    process.stderr.write(`Hosted Access workerd output:\n${stdout}\n${stderr}`.slice(0, 12_000));
  }
  throw error;
} finally {
  jwksServer?.stop(true);
  fakeGithub?.stop();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function signAccessToken(
  privateKey: KeyLike,
  issuer: string,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function authenticatedFetch(origin: string, path: string, token: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: hostedAuthHeaders(token),
  });
}

function importRun(origin: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/api/runs`, {
    method: "POST",
    headers: hostedAuthHeaders(token, origin),
    body: JSON.stringify(body),
  });
}

async function expectStatus(
  responsePromise: Promise<Response> | Response,
  expected: number,
  label: string,
): Promise<Response> {
  const response = await responsePromise;
  if (response.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, received ${response.status}: ${await response.text()}`,
    );
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

async function runChecked(command: string[], label: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${label} failed (${exitCode}):\n${stdout}\n${stderr}`.slice(0, 12_000));
  }
}

async function reservePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitForWorker(
  origin: string,
  child: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/health`, { redirect: "manual" });
      if (response.status === 403) return;
    } catch {
      // workerd is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("Hosted Access contract Worker did not become ready.");
}
