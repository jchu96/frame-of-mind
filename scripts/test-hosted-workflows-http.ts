import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import {
  GeminiVideoAnalyzer,
  MODEL_REQUEST_TIMEOUT_MS,
} from "../src/adapters/gemini";
import type { SealedHostedMediaReceipt } from "../apps/workflows/src/contracts";
import {
  GeminiHostedAnalysisProvider,
} from "../apps/workflows/src/provider";
import { createE2EEnvironment } from "./e2e-environment";

const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-workflows-"));
const persistRoot = join(temporaryRoot, "wrangler-state");
const webConfigPath = join(temporaryRoot, "web.wrangler.jsonc");
const workflowConfigPath = join(temporaryRoot, "workflow.wrangler.jsonc");
const seedPath = join(temporaryRoot, "seed.sql");
const workflowOutdir = join(temporaryRoot, "workflow-bundle");
const databaseName = "frame-of-mind-hosted-workflow-contract";
const databaseId = "00000000-0000-0000-0000-000000000004";
const audience = "frame-of-mind-hosted-workflow-contract";
const keyId = "hosted-workflow-contract-key";
const principalA = "hosted-workflow-principal-a";
const principalB = "hosted-workflow-principal-b";
const normalMedia = "media_hosted_normal_0001";
const crashMedia = "media_hosted_crash_0001";
const mediaSha256 = "a".repeat(64);
const wranglerBin = resolve("apps/web/node_modules/wrangler/bin/wrangler.js");
let webWorker: ReturnType<typeof Bun.spawn> | undefined;
let workflowWorker: ReturnType<typeof Bun.spawn> | undefined;
let jwksServer: ReturnType<typeof Bun.serve> | undefined;
let webOutput: Promise<[string, string]> | undefined;
let workflowOutput: Promise<[string, string]> | undefined;

try {
  console.log("HOSTED_WORKFLOW build=START nuxt_and_workflow");
  await runChecked(
    ["bun", "--no-env-file", "run", "--cwd", "apps/web", "build:cloudflare"],
    "hosted Nuxt Worker build",
    {
      FRAME_OF_MIND_STUDIO: "1",
      FRAME_OF_MIND_HOSTED_WORKFLOWS: "1",
    },
  );
  const nitroBundle = await readFile(
    resolve("apps/web/.output/server/chunks/nitro/nitro.mjs"),
    "utf8",
  );
  for (const marker of ["/api/hosted/jobs", "Hosted Workflow bindings are unavailable"]) {
    if (!nitroBundle.includes(marker)) {
      throw new Error(`Hosted Nuxt build omitted ${marker}.`);
    }
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
  await writeFile(webConfigPath, JSON.stringify({
    $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
    name: "frame-of-mind-hosted-web-contract",
    main: resolve("apps/web/.output/server/index.mjs"),
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      directory: resolve("apps/web/.output/public"),
      binding: "ASSETS",
    },
    d1_databases: [d1Binding()],
    services: [{
      binding: "HOSTED_WORKFLOWS",
      service: "frame-of-mind-hosted-workflow-contract",
    }],
    vars: {
      NUXT_AUTH_MODE: "cloudflare-access",
      NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN: issuer,
      NUXT_CLOUDFLARE_ACCESS_AUD: audience,
      NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS: "true",
      NUXT_HOSTED_WORKFLOWS_ENABLED: "true",
      NUXT_HOSTED_WORKFLOW_RESERVATION_UNITS: "1",
    },
  }, null, 2));
  await writeFile(workflowConfigPath, JSON.stringify({
    $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
    name: "frame-of-mind-hosted-workflow-contract",
    main: resolve("apps/workflows/src/index.ts"),
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [d1Binding()],
    workflows: [{
      name: "frame-of-mind-analysis-contract",
      binding: "HOSTED_WORKFLOW",
      class_name: "HostedAnalysisWorkflow",
    }],
    vars: {
      HOSTED_FAKE_GEMINI: "true",
      HOSTED_FAKE_RECEIPT_FAILURE_MEDIA_ID: crashMedia,
      HOSTED_FAKE_RECEIPT_FAILURE_STEP: "transcribe",
    },
  }, null, 2));
  await runChecked([
    "node", wranglerBin, "deploy", "--dry-run", "--config", workflowConfigPath,
    "--outdir", workflowOutdir,
  ], "Workflow Worker dry run");
  console.log("HOSTED_WORKFLOW build=PASS nuxt_and_workflow");
  await verifyRealAdapterContract();

  const migrationArgs = [
    "node", wranglerBin, "d1", "migrations", "apply", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
  ];
  await runChecked(migrationArgs, "hosted Workflow D1 migrations");
  await writeFile(seedPath, seedSql());
  await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
    "--file", seedPath,
  ], "hosted Workflow fixture seed");

  const workflowPort = await reservePort();
  workflowWorker = Bun.spawn([
    "node", wranglerBin, "dev", "--local",
    "--config", workflowConfigPath,
    "--persist-to", persistRoot,
    "--ip", "127.0.0.1",
    "--port", String(workflowPort),
    "--log-level", "error",
    "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  workflowOutput = Promise.all([
    new Response(workflowWorker.stdout).text(),
    new Response(workflowWorker.stderr).text(),
  ]);
  await waitForWorker(
    `http://127.0.0.1:${workflowPort}/health`,
    workflowWorker,
    200,
  );

  const workerPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${workerPort}`;
  webWorker = Bun.spawn([
    "node", wranglerBin, "dev", "--local",
    "--config", webConfigPath,
    "--persist-to", persistRoot,
    "--ip", "127.0.0.1",
    "--port", String(workerPort),
    "--log-level", "error",
    "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  webOutput = Promise.all([
    new Response(webWorker.stdout).text(),
    new Response(webWorker.stderr).text(),
  ]);
  await waitForWorker(`${baseUrl}/api/health`, webWorker, 403);

  const tokenA = await signAccessToken(keys.privateKey, issuer, principalA);
  const tokenB = await signAccessToken(keys.privateKey, issuer, principalB);
  const normal = await createJob(baseUrl, tokenA, normalMedia, "normal-submit-key");
  const normalTerminal = await waitForTerminal(baseUrl, tokenA, normal.job.id);
  assertEqual(normalTerminal.job.stage, "succeeded", "normal terminal stage");
  assertEqual(normalTerminal.job.cleanupCompleted, true, "normal cleanup");
  await expectStatus(
    authenticatedFetch(baseUrl, `/api/hosted/jobs/${normal.job.id}`, tokenB),
    404,
    "cross-principal hosted detail",
  );
  console.log("HOSTED_WORKFLOW principal_isolation=PASS foreign_detail=404");

  const crashed = await createJob(baseUrl, tokenA, crashMedia, "crash-submit-key");
  const crashTerminal = await waitForTerminal(baseUrl, tokenA, crashed.job.id);
  assertEqual(crashTerminal.job.stage, "indeterminate", "crash terminal stage");
  assertEqual(crashTerminal.job.cleanupCompleted, true, "crash cleanup");
  assertEqual(
    crashTerminal.events.filter((event) => event.code === "gemini_transcribe_started").length,
    1,
    "provider invocation count after receipt crash",
  );
  const workflowInstanceId = await queryWorkflowInstanceId(
    crashed.job.id,
  );
  await runChecked([
    "node", wranglerBin, "workflows", "instances", "restart",
    "frame-of-mind-analysis-contract", workflowInstanceId,
    "--local", "--port", String(workflowPort),
    "--config", workflowConfigPath,
    "--from-step-name", "transcribe",
    "--from-step-type", "do",
  ], "restart crashed Workflow from provider step");
  const afterReplay = await waitForEvent(
    baseUrl,
    tokenA,
    crashed.job.id,
    "provider_claim_without_receipt",
  );
  assertEqual(
    afterReplay.events.filter((event) => event.code === "gemini_transcribe_started").length,
    1,
    "no second provider invocation after replay",
  );
  assertEqual(afterReplay.job.stage, "indeterminate", "replayed crash stage");
  assertEqual(afterReplay.job.cleanupCompleted, true, "replayed crash cleanup");
  console.log(
    "HOSTED_WORKFLOW crash_after_provider=PASS provider_calls=1 indeterminate=true cleanup=true",
  );

  const [retryOneResponse, retryTwoResponse] = await Promise.all([
    retryJob(baseUrl, tokenA, crashed.job.id, "retry-submit-key"),
    retryJob(baseUrl, tokenA, crashed.job.id, "retry-submit-key"),
  ]);
  const retryOne = await json<JobResponse>(
    await expectOneOf(retryOneResponse, [200, 201], "first retry submit"),
  );
  const retryTwo = await json<JobResponse>(
    await expectOneOf(retryTwoResponse, [200, 201], "second retry submit"),
  );
  assertEqual(retryOne.job.id, retryTwo.job.id, "retry double-submit identity");
  if (retryOne.job.id === crashed.job.id) {
    throw new Error("Retry reused the prior attempt ID.");
  }
  if ("workflowInstanceId" in retryOne.job || "workflowInstanceId" in retryTwo.job) {
    throw new Error("Hosted route exposed an internal Workflow instance ID.");
  }
  const retryTerminal = await waitForTerminal(baseUrl, tokenA, retryOne.job.id);
  assertEqual(retryTerminal.job.stage, "indeterminate", "retry terminal stage");
  const parentAfterRetry = await getJob(baseUrl, tokenA, crashed.job.id);
  assertEqual(parentAfterRetry.job.stage, "indeterminate", "prior attempt immutable");
  console.log("HOSTED_WORKFLOW retry=PASS linked_new_attempt double_submit_deduped");
  console.log("HOSTED_WORKFLOW_CONTRACT PASSED");

  webWorker.kill("SIGTERM");
  workflowWorker.kill("SIGTERM");
  await Promise.all([webWorker.exited, workflowWorker.exited]);
  await Promise.all([webOutput, workflowOutput]);
} catch (error) {
  if (webWorker) {
    webWorker.kill("SIGTERM");
    await webWorker.exited;
  }
  if (workflowWorker) {
    workflowWorker.kill("SIGTERM");
    await workflowWorker.exited;
  }
  if (webOutput) {
    const [stdout, stderr] = await webOutput;
    process.stderr.write(`Hosted web workerd output:\n${stdout}\n${stderr}`.slice(0, 10_000));
  }
  if (workflowOutput) {
    const [stdout, stderr] = await workflowOutput;
    process.stderr.write(`Hosted Workflow workerd output:\n${stdout}\n${stderr}`.slice(0, 10_000));
  }
  throw error;
} finally {
  jwksServer?.stop(true);
  if (process.env.KEEP_HOSTED_WORKFLOW_TEMP === "1") {
    console.error(`Hosted Workflow temp retained at ${temporaryRoot}`);
  } else {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

interface JobView {
  id: string;
  stage: string;
  cleanupCompleted: boolean;
}

interface JobResponse {
  job: JobView;
}

interface JobDetail extends JobResponse {
  events: Array<{ code?: string }>;
}

async function verifyRealAdapterContract(): Promise<void> {
  let requestTimeout: number | undefined;
  const deletedFiles: string[] = [];
  const analyzer = new GeminiVideoAnalyzer(
    "hosted-contract-fake-key",
    "gemini-hosted-contract",
    {
      generateContent: async (parameters) => {
        requestTimeout = parameters.config?.httpOptions?.timeout;
        return {
          text: JSON.stringify({
            segments: [{
              start: "00:00:00",
              end: "00:00:01",
              speaker: "Speaker 1",
              text: "Hosted adapter transport contract.",
            }],
          }),
        };
      },
      deleteFile: async (parameters) => {
        deletedFiles.push(parameters.name);
        return {};
      },
    },
  );
  const provider = new GeminiHostedAnalysisProvider(analyzer);
  const file = (suffix: string) => ({
    name: `files/adapter_${suffix}`,
    uri: `https://generativelanguage.googleapis.test/v1beta/files/adapter_${suffix}`,
    mimeType: "video/mp4",
  });
  await provider.transcribe(file("timeout"));
  assertEqual(
    requestTimeout,
    MODEL_REQUEST_TIMEOUT_MS,
    "real hosted adapter model timeout",
  );
  console.log("HOSTED_WORKFLOW adapter_timeout=PASS");

  const ephemeralReceipt = (suffix: string): SealedHostedMediaReceipt => ({
    principalSub: principalA,
    mediaId: `media_adapter_${suffix}`,
    geminiFileName: `files/adapter_${suffix}`,
    geminiFileUri: `https://generativelanguage.googleapis.test/v1beta/files/adapter_${suffix}`,
    sha256: mediaSha256,
    mimeType: "video/mp4",
    retention: "ephemeral",
    sealedAt: "2026-08-22T00:00:00.000Z",
    expiresAt: "2026-08-29T00:00:00.000Z",
  });
  await provider.cleanup(
    file("success"),
    ephemeralReceipt("success"),
  );
  await provider.cleanup(
    file("receipt_failure"),
    ephemeralReceipt("receipt_failure"),
  );
  assertEqual(
    deletedFiles,
    ["files/adapter_success", "files/adapter_receipt_failure"],
    "real hosted adapter ephemeral Files API deletes",
  );
  console.log(
    "HOSTED_WORKFLOW ephemeral_delete=PASS success=true failure=true",
  );
}

function d1Binding() {
  return {
    binding: "DB",
    database_name: databaseName,
    database_id: databaseId,
    migrations_dir: resolve("apps/web/db/migrations"),
  };
}

function seedSql(): string {
  const sealedAt = "2026-08-22T00:00:00.000Z";
  const expiresAt = "2026-08-29T00:00:00.000Z";
  const mediaRows = [principalA, principalB].flatMap((principal) =>
    [normalMedia, crashMedia].map((mediaId) =>
      `('${principal}','${mediaId}','files/${mediaId}',`
      + `'https://generativelanguage.googleapis.test/v1beta/files/${mediaId}',`
      + `'${mediaSha256}','video/mp4','${mediaId === crashMedia ? "ephemeral" : "retained"}',`
      + `'${sealedAt}','${expiresAt}')`
    )
  );
  return `
    INSERT INTO hosted_principal_spend (
      principal_sub, principal_email, cap_units, committed_units, updated_at
    ) VALUES
      ('${principalA}', 'seat@example.test', 20, 0, '${sealedAt}'),
      ('${principalB}', 'seat@example.test', 20, 0, '${sealedAt}');
    INSERT INTO hosted_media_receipts (
      principal_sub, media_id, gemini_file_name, gemini_file_uri, sha256,
      mime_type, retention, sealed_at, expires_at
    ) VALUES ${mediaRows.join(",\n")};
  `;
}

async function signAccessToken(
  privateKey: KeyLike,
  issuer: string,
  subject: string,
): Promise<string> {
  return new SignJWT({ sub: subject, email: "seat@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function createJob(
  origin: string,
  token: string,
  mediaId: string,
  idempotencyKey: string,
  expectedStatus = 201,
): Promise<JobResponse> {
  return await json<JobResponse>(await expectStatus(fetch(`${origin}/api/hosted/jobs`, {
    method: "POST",
    headers: mutationHeaders(origin, token),
    body: JSON.stringify({
      idempotencyKey,
      mediaId,
      context: { mode: "none" },
      recipeId: "decisions",
    }),
  }), expectedStatus, `create ${idempotencyKey}`));
}

function retryJob(
  origin: string,
  token: string,
  attemptId: string,
  idempotencyKey: string,
): Promise<Response> {
  return fetch(`${origin}/api/hosted/jobs/${attemptId}/retry`, {
    method: "POST",
    headers: mutationHeaders(origin, token),
    body: JSON.stringify({ idempotencyKey }),
  });
}

function mutationHeaders(origin: string, token: string): Record<string, string> {
  return {
    "cf-access-jwt-assertion": token,
    "content-type": "application/json",
    origin,
  };
}

function authenticatedFetch(origin: string, path: string, token: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { "cf-access-jwt-assertion": token },
  });
}

async function getJob(origin: string, token: string, id: string): Promise<JobDetail> {
  return await json<JobDetail>(await expectStatus(
    authenticatedFetch(origin, `/api/hosted/jobs/${id}`, token),
    200,
    `job ${id}`,
  ));
}

async function waitForTerminal(
  origin: string,
  token: string,
  id: string,
): Promise<JobDetail> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const detail = await getJob(origin, token, id);
    if (["succeeded", "failed", "canceled", "indeterminate"].includes(detail.job.stage)) {
      return detail;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Hosted attempt ${id} did not become terminal.`);
}

async function waitForEvent(
  origin: string,
  token: string,
  id: string,
  code: string,
): Promise<JobDetail> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const detail = await getJob(origin, token, id);
    if (detail.events.some((event) => event.code === code)) return detail;
    await Bun.sleep(100);
  }
  throw new Error(`Hosted attempt ${id} did not record ${code}.`);
}

async function queryWorkflowInstanceId(attemptId: string): Promise<string> {
  const stdout = await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
    "--command",
    `SELECT workflow_instance_id FROM hosted_analysis_attempts WHERE attempt_id = '${attemptId}'`,
    "--json",
  ], "query crashed Workflow instance ID");
  const result = JSON.parse(stdout) as Array<{
    results?: Array<{ workflow_instance_id?: string }>;
  }>;
  const workflowInstanceId = result[0]?.results?.[0]?.workflow_instance_id;
  if (!workflowInstanceId) throw new Error("Crashed Workflow instance ID was unavailable.");
  return workflowInstanceId;
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

async function expectOneOf(
  responsePromise: Promise<Response> | Response,
  expected: number[],
  label: string,
): Promise<Response> {
  const response = await responsePromise;
  if (!expected.includes(response.status)) {
    throw new Error(
      `${label}: expected HTTP ${expected.join("/")}, received ${response.status}: ${await response.text()}`,
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

async function runChecked(
  command: string[],
  label: string,
  additions: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env, additions),
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
    throw new Error(`${label} failed (${exitCode}):\n${stdout}\n${stderr}`.slice(0, 20_000));
  }
  return stdout;
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
  url: string,
  child: ReturnType<typeof Bun.spawn>,
  expectedStatus: number,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status === expectedStatus) return;
    } catch {
      // workerd is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("Hosted Workflow contract Workers did not become ready.");
}
