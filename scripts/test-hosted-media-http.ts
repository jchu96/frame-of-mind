import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { createE2EEnvironment } from "./e2e-environment";

const root = await mkdtemp(join(tmpdir(), "frame-of-mind-hosted-media-"));
const persistRoot = join(root, "wrangler-state");
const configPath = join(root, "wrangler.jsonc");
const databaseName = "frame-of-mind-hosted-media-contract";
const databaseId = "00000000-0000-0000-0000-000000000007";
const audience = "frame-of-mind-hosted-media-contract";
const keyId = "hosted-media-contract-key";
const fixtureKey = "fixture-only-gemini-key";
const wranglerBin = resolve("apps/web/node_modules/wrangler/bin/wrangler.js");
const sessions = new Map<string, FakeSession>();
let nextSession = 0;
let filesApi: ReturnType<typeof Bun.serve> | undefined;
let filesApiOrigin = "";
let jwks: ReturnType<typeof Bun.serve> | undefined;
let worker: ReturnType<typeof Bun.spawn> | undefined;
let workerOutput: Promise<[string, string]> | undefined;

try {
  console.log("HOSTED_MEDIA build=START cloudflare_module");
  await runChecked(
    ["bun", "--no-env-file", "run", "--cwd", "apps/web", "build:cloudflare"],
    "hosted media Cloudflare build",
  );
  console.log("HOSTED_MEDIA build=PASS cloudflare_module");

  filesApi = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fakeFilesFetch });
  const filesOrigin = `http://127.0.0.1:${filesApi.port}`;
  filesApiOrigin = filesOrigin;
  const keys = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(keys.publicKey);
  jwks = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/cdn-cgi/access/certs") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({ keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }] });
    },
  });
  const issuer = `http://127.0.0.1:${jwks.port}`;
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  await writeFile(configPath, JSON.stringify({
    $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
    name: "frame-of-mind-hosted-media-contract",
    main: resolve("apps/web/.output/server/hosted-entry.mjs"),
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
    assets: { directory: resolve("apps/web/.output/public"), binding: "ASSETS" },
    d1_databases: [{
      binding: "DB", database_name: databaseName, database_id: databaseId,
      migrations_dir: resolve("apps/web/db/migrations"),
    }],
    vars: {
      NUXT_AUTH_MODE: "cloudflare-access",
      NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN: issuer,
      NUXT_CLOUDFLARE_ACCESS_AUD: audience,
      NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS: "true",
      NUXT_HOSTED_WORKFLOWS_ENABLED: "true",
      NUXT_HOSTED_MEDIA_OPEN_SESSION_CAP: "2",
      NUXT_HOSTED_MEDIA_MAX_BYTES: String(1024 * 1024),
      NUXT_HOSTED_MEDIA_SESSION_TTL_SECONDS: "3600",
      HOSTED_GEMINI_FILES_BASE_URL: filesOrigin,
      GEMINI_API_KEY: fixtureKey,
    },
  }, null, 2));
  await runChecked([
    "node", wranglerBin, "d1", "migrations", "apply", databaseName,
    "--local", "--config", configPath, "--persist-to", persistRoot,
  ], "hosted media D1 migrations");
  worker = Bun.spawn([
    "node", wranglerBin, "dev", "--local", "--config", configPath,
    "--persist-to", persistRoot, "--ip", "127.0.0.1", "--port", String(port),
    "--log-level", "error", "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(), env: createE2EEnvironment(process.env), stdin: "ignore",
    stdout: "pipe", stderr: "pipe",
  });
  workerOutput = Promise.all([
    new Response(worker.stdout).text(), new Response(worker.stderr).text(),
  ]);
  await waitForWorker(`${origin}/api/health`, worker, 403);
  const tokenA = await signToken(keys.privateKey, issuer, "media-principal-a");
  const tokenB = await signToken(keys.privateKey, issuer, "media-principal-b");

  const capA = await createSession(origin, tokenA, bytes(300_001, 1));
  const capB = await createSession(origin, tokenA, bytes(300_002, 2));
  assert(fakeFor(capA).name === undefined, "fake Files API exposed a File name before finalize");
  await expectStatus(createResponse(origin, tokenA, bytes(300_003, 3)), 429, "third open session");
  assert(sessions.size === 2, "cap must be enforced before a third provider session starts");
  await cancel(origin, tokenA, capA.mediaId);
  assert(await uploadState(capA.mediaId) === "abandoned", "pre-final cancel did not abandon D1 state");
  assert(fakeFor(capA).fileDeleteCalls === 0, "pre-final cancel issued a nonexistent File delete");
  assert(fakeFor(capA).sessionDeleteCalls === 0, "pre-final cancel issued an unsupported session delete");
  await expectStatus(sealResponse(origin, tokenA, capA.mediaId), 409, "seal after pre-final cancel");
  const incompleteSeal = await expectStatus(
    sealResponse(origin, tokenA, capB.mediaId),
    409,
    "incomplete upload seal",
  );
  assert(
    (await incompleteSeal.json() as { data?: { code?: string } }).data?.code
      === "hosted_media_upload_incomplete",
    "incomplete seal did not return its stable code",
  );
  await cancel(origin, tokenA, capB.mediaId);
  console.log("HOSTED_MEDIA cap=PASS default_test_cap=2 third=429 provider_starts=2 cancel_pre_finalize=provider_ttl incomplete_seal=refused");

  const foreignOpen = await openSessions(origin, tokenB);
  assert(foreignOpen.length === 0, "open-session listing crossed principal boundaries");
  await browserRecoveryContract(origin, tokenA);

  const recording = bytes(700_123, 19);
  const direct = await createSession(origin, tokenA, recording);
  assert(!direct.uploadUrl.includes(fixtureKey), "upload URL leaked the API key");
  const stored = await d1Json(
    "SELECT upload_url_ciphertext, upload_url_iv FROM hosted_media_upload_sessions "
      + `WHERE media_id = '${direct.mediaId}'`,
  );
  assert(!JSON.stringify(stored).includes("upload_id"), "D1 persisted a plaintext upload capability");
  await browserResumeContract(origin, tokenA, direct, recording);
  await expectStatus(sealResponse(origin, tokenB, direct.mediaId), 404, "cross-principal seal");
  const sealed = await expectStatus(sealResponse(origin, tokenA, direct.mediaId), 200, "exact seal");
  const sealedBody = await sealed.json() as { media?: { id?: string; sha256?: string } };
  assert(sealedBody.media?.id === direct.mediaId, "seal receipt media ID mismatch");
  assert(sealedBody.media?.sha256 === digestHex(recording), "seal receipt digest mismatch");
  assert(await countReceipts(direct.mediaId) === 1, "exact upload omitted its receipt");
  console.log("HOSTED_MEDIA direct=PASS chromium=true resume=query_after_reload seal=exact");

  await rejectionCase(origin, tokenA, "size", bytes(330_001, 31));
  await rejectionCase(origin, tokenA, "digest", bytes(330_002, 32));
  await rejectionCase(origin, tokenA, "missing", bytes(330_003, 33));
  console.log("HOSTED_MEDIA mismatch=PASS size=true same_size_digest=true missing_hash=true deleted=true");

  const abandoned = await createSession(origin, tokenA, bytes(340_001, 44));
  await expire(abandoned.mediaId);
  const swept = await expectStatus(janitorResponse(origin, tokenA), 200, "expired upload janitor");
  const sweptBody = await swept.json() as { abandoned?: number };
  assert(sweptBody.abandoned === 1, "janitor did not abandon exactly one expired session");
  assert(await uploadState(abandoned.mediaId) === "abandoned", "janitor did not abandon D1 state");
  assert(fakeFor(abandoned).fileDeleteCalls === 0, "janitor deleted a nonexistent pre-final File");
  assert(fakeFor(abandoned).sessionDeleteCalls === 0, "janitor issued an unsupported session delete");

  const racedBytes = bytes(360_001, 55);
  const raced = await createSession(origin, tokenA, racedBytes);
  await uploadAll(raced, racedBytes);
  const racedFake = fakeFor(raced);
  racedFake.holdGet = deferred<void>();
  racedFake.getEntered = deferred<void>();
  const sealRace = sealResponse(origin, tokenA, raced.mediaId);
  await racedFake.getEntered.promise;
  await expire(raced.mediaId);
  const raceSweep = await expectStatus(janitorResponse(origin, tokenA), 200, "seal janitor race");
  assert((await raceSweep.json() as { abandoned: number }).abandoned === 0, "janitor stole an active seal");
  racedFake.holdGet.resolve();
  await expectStatus(sealRace, 200, "seal wins janitor race");
  assert(!racedFake.deleted, "janitor deleted the file being sealed");
  console.log("HOSTED_MEDIA cleanup=PASS cancel=true expired=true seal_race=true");

  await expectStatus(createResponse(origin, tokenA, bytes(1024 * 1024 + 1, 70)), 422, "configured size ceiling");
  console.log("HOSTED_MEDIA_CONTRACT PASSED");
} catch (error) {
  if (workerOutput && worker) {
    worker.kill("SIGTERM");
    await worker.exited.catch(() => undefined);
    const [stdout, stderr] = await workerOutput;
    console.error(`${stdout}\n${stderr}`.slice(-12_000));
    worker = undefined;
  }
  throw error;
} finally {
  if (worker) {
    worker.kill("SIGTERM");
    await worker.exited.catch(() => undefined);
    await workerOutput?.catch(() => undefined);
  }
  jwks?.stop(true);
  filesApi?.stop(true);
  await rm(root, { recursive: true, force: true });
}

interface SessionResponse {
  mediaId: string;
  uploadUrl: string;
  partBytes: number;
  sessionExpiresAt: string;
}

interface FakeSession {
  id: string;
  name?: string;
  mediaId: string;
  declared: number;
  mimeType: string;
  chunks: Uint8Array[];
  received: number;
  final: boolean;
  deleted: boolean;
  fileDeleteCalls: number;
  sessionDeleteCalls: number;
  queryCount: number;
  mode: "exact" | "size" | "digest" | "missing";
  holdGet?: Deferred<void>;
  getEntered?: Deferred<void>;
}

interface Deferred<T> { promise: Promise<T>; resolve(value?: T): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value?: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done as (value?: T) => void; }), resolve };
}

async function fakeFilesFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST,PUT,GET,DELETE,OPTIONS",
    "access-control-allow-headers": request.headers.get("access-control-request-headers") || "*",
    "access-control-expose-headers": "x-goog-upload-url,x-goog-upload-chunk-granularity,x-goog-upload-size-received,x-goog-upload-status,x-goog-upload-file-name",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname === "/upload/v1beta/files" && request.method === "POST") {
    assert(request.headers.get("x-goog-api-key") === fixtureKey, "start omitted Worker API key");
    const body = await request.json() as { file?: { display_name?: string } };
    const id = `upload_${++nextSession}`;
    const session: FakeSession = {
      id, mediaId: body.file?.display_name || "",
      declared: Number(request.headers.get("x-goog-upload-header-content-length")),
      mimeType: request.headers.get("x-goog-upload-header-content-type") || "",
      chunks: [], received: 0, final: false, deleted: false,
      fileDeleteCalls: 0, sessionDeleteCalls: 0, queryCount: 0, mode: "exact",
    };
    sessions.set(id, session);
    return new Response(null, { status: 200, headers: {
      ...cors,
      "x-goog-upload-url": `${filesApiOrigin}/upload/session?upload_protocol=resumable&upload_id=${id}`,
      "x-goog-upload-chunk-granularity": String(256 * 1024),
    } });
  }
  if (url.pathname === "/upload/session") {
    const session = sessions.get(url.searchParams.get("upload_id") || "");
    if (!session || session.deleted) return new Response("gone", { status: 410, headers: cors });
    if (request.method === "DELETE") {
      session.sessionDeleteCalls += 1;
      return new Response("session revoke unsupported", { status: 405, headers: cors });
    }
    const command = request.headers.get("x-goog-upload-command") || "";
    if (request.method === "PUT" && command === "query") {
      session.queryCount += 1;
      return new Response(session.final ? JSON.stringify({ file: { name: session.name } }) : null, {
        status: 200,
        headers: { ...cors, "x-goog-upload-size-received": String(session.received), "x-goog-upload-status": session.final ? "final" : "active" },
      });
    }
    if (request.method === "PUT" && command.includes("upload")) {
      const offset = Number(request.headers.get("x-goog-upload-offset"));
      const chunk = new Uint8Array(await request.arrayBuffer());
      if (offset !== session.received || session.received + chunk.length > session.declared) {
        return new Response("offset or size mismatch", { status: 400, headers: cors });
      }
      session.chunks.push(chunk);
      session.received += chunk.length;
      if (command.includes("finalize")) {
        if (session.received !== session.declared) return new Response("short", { status: 400, headers: cors });
        session.final = true;
        session.name = `files/f_${session.id}`;
        return Response.json({ file: { name: session.name } }, { headers: cors });
      }
      return new Response(null, { status: 200, headers: cors });
    }
  }
  const name = url.pathname.replace(/^\/v1beta\//, "");
  const session = [...sessions.values()].find((candidate) =>
    candidate.final && candidate.name === name
  );
  if (session && request.method === "DELETE") {
    assert(request.headers.get("x-goog-api-key") === fixtureKey, "delete omitted Worker API key");
    session.fileDeleteCalls += 1;
    session.deleted = true;
    return new Response(null, { status: 204, headers: cors });
  }
  if (session && request.method === "GET" && !session.deleted) {
    assert(request.headers.get("x-goog-api-key") === fixtureKey, "get omitted Worker API key");
    if (session.holdGet) {
      session.getEntered ??= deferred<void>();
      session.getEntered.resolve();
      await session.holdGet.promise;
    }
    const payload = concat(session.chunks);
    return Response.json({
      name: session.name,
      uri: `https://generativelanguage.googleapis.test/v1beta/${session.name}`,
      mimeType: session.mimeType,
      sizeBytes: session.mode === "size" ? session.received + 1 : session.received,
      ...(session.mode === "missing" ? {} : {
        sha256Hash: session.mode === "digest"
          ? createHash("sha256").update("substitute").digest("base64")
          : createHash("sha256").update(payload).digest("base64"),
      }),
      expirationTime: new Date(Date.now() + 60 * 60_000).toISOString(),
    }, { headers: cors });
  }
  return new Response("not found", { status: 404, headers: cors });
}

async function browserResumeContract(
  origin: string,
  token: string,
  session: SessionResponse,
  payload: Uint8Array,
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ extraHTTPHeaders: { "cf-access-jwt-assertion": token } });
    const first = await context.newPage();
    await first.goto(`${origin}/api/health`);
    const encoded = Buffer.from(payload).toString("base64");
    await first.evaluate(async ({ uploadUrl, partBytes, encoded, mediaId }) => {
      const binary = atob(encoded);
      const data = Uint8Array.from(binary, (value) => value.charCodeAt(0));
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": "video/webm", "x-goog-upload-offset": "0", "x-goog-upload-command": "upload" },
        body: data.slice(0, partBytes),
      });
      if (!response.ok) throw new Error(`first upload ${response.status}`);
      sessionStorage.setItem("hosted-media-contract", JSON.stringify({ mediaId, uploadUrl, offset: partBytes }));
    }, { uploadUrl: session.uploadUrl, partBytes: session.partBytes, encoded, mediaId: session.mediaId });
    await first.reload();
    const resumed = await first.evaluate(async ({ uploadUrl, partBytes, encoded }) => {
      const saved = JSON.parse(sessionStorage.getItem("hosted-media-contract") || "null") as { offset: number };
      const query = await fetch(uploadUrl, { method: "PUT", headers: { "x-goog-upload-command": "query" } });
      let offset = Number(query.headers.get("x-goog-upload-size-received"));
      if (!query.ok || offset !== saved.offset) throw new Error("authoritative resume offset mismatch");
      const binary = atob(encoded);
      const data = Uint8Array.from(binary, (value) => value.charCodeAt(0));
      while (offset < data.length) {
        const end = Math.min(offset + partBytes, data.length);
        const response = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "content-type": "video/webm", "x-goog-upload-offset": String(offset), "x-goog-upload-command": end === data.length ? "upload, finalize" : "upload" },
          body: data.slice(offset, end),
        });
        if (!response.ok) throw new Error(`resume upload ${response.status}`);
        offset = end;
      }
      return offset;
    }, { uploadUrl: session.uploadUrl, partBytes: session.partBytes, encoded });
    assert(resumed === payload.length, "Chromium resume did not send every byte");

    const second = await context.newPage();
    await second.goto(`${origin}/api/health`);
    await first.evaluate((mediaId) => {
      const gate = new Promise<void>((resolve) => { (globalThis as typeof globalThis & { releaseLock?: () => void }).releaseLock = resolve; });
      void navigator.locks.request(`frame-of-mind:hosted-upload:${mediaId}`, async () => gate);
    }, session.mediaId);
    const secondAcquired = await second.evaluate(async (mediaId) => {
      return await navigator.locks.request(
        `frame-of-mind:hosted-upload:${mediaId}`,
        { ifAvailable: true },
        async (lock) => Boolean(lock),
      );
    }, session.mediaId);
    assert(secondAcquired === false, "two tabs acquired one upload session lock");
    await first.evaluate(() => (globalThis as typeof globalThis & { releaseLock?: () => void }).releaseLock?.());
    await context.close();
  } finally {
    await browser.close();
  }
}

async function browserRecoveryContract(
  origin: string,
  token: string,
): Promise<void> {
  const recoveryBytes = bytes(610_123, 81);
  const blockerBytes = bytes(300_111, 82);
  const recovery = await createSession(origin, token, recoveryBytes);
  const blocker = await createSession(origin, token, blockerBytes);
  const recoveryFake = fakeFor(recovery);
  const firstPart = recoveryBytes.slice(0, recovery.partBytes);
  await expectStatus(fetch(recovery.uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": "video/webm",
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload",
    },
    body: firstPart,
  }), 200, "browser recovery first part");
  await expectStatus(
    createResponse(origin, token, bytes(300_112, 83)),
    429,
    "browser recovery full cap",
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      extraHTTPHeaders: { "cf-access-jwt-assertion": token },
    });
    let pagehideDeleteObserved = false;
    const cancelPath = `/api/hosted/media/${recovery.mediaId}`;
    await context.route(`**${cancelPath}`, async (route) => {
      if (route.request().method() === "DELETE") {
        pagehideDeleteObserved = true;
        await route.abort();
        return;
      }
      await route.continue();
    });
    const first = await context.newPage();
    await first.addInitScript((draft) => {
      sessionStorage.setItem(
        "frame-of-mind:hosted:media-upload:v1",
        JSON.stringify(draft),
      );
    }, {
      schemaVersion: 1,
      ...recovery,
      declaredSizeBytes: recoveryBytes.length,
      declaredSha256: digestHex(recoveryBytes),
      mimeType: "video/webm",
      durationSeconds: 3,
      retention: "ephemeral",
      offset: firstPart.length,
    });
    await first.goto(`${origin}/hosted/new/recording`);
    await first.locator("[data-hosted-composer=recording]").waitFor();
    await first.getByText(
      "An unfinished upload was found. Reselect the same recording to resume.",
    ).waitFor();
    await first.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    for (let attempt = 0; attempt < 50 && !pagehideDeleteObserved; attempt += 1) {
      await Bun.sleep(20);
    }
    assert(pagehideDeleteObserved, "pagehide did not send a keepalive DELETE");
    await first.close();
    await context.unroute(`**${cancelPath}`);

    const second = await context.newPage();
    await second.goto(`${origin}/hosted/new/recording`);
    const recovered = second.locator(
      `[data-hosted-open-session="${recovery.mediaId}"]`,
    );
    await recovered.waitFor();
    assert(
      await recovered.locator(`[data-hosted-resume-session="${recovery.mediaId}"]`).count() === 1,
      "recovered session omitted Resume",
    );
    assert(
      await recovered.locator(`[data-hosted-discard-session="${recovery.mediaId}"]`).count() === 1,
      "recovered session omitted Discard",
    );
    const queriesBeforeResume = recoveryFake.queryCount;
    await recovered.locator(`[data-hosted-resume-session="${recovery.mediaId}"]`).click();
    await second.getByText("Reselect the same recording to resume.").waitFor();
    assert(
      recoveryFake.queryCount > queriesBeforeResume,
      "Resume did not query the authoritative provider offset",
    );
    await second.getByRole("button", { name: "Cancel upload" }).click();
    await second.getByText("Upload session abandoned and browser receipt cleared.").waitFor();
    assert(await uploadState(recovery.mediaId) === "abandoned", "Discard did not abandon recovered D1 state");
    assert(recoveryFake.fileDeleteCalls === 0, "Discard deleted a nonexistent pre-final File");
    const admitted = await createSession(origin, token, bytes(300_113, 84));
    await cancel(origin, token, admitted.mediaId);
    await cancel(origin, token, blocker.mediaId);
    await context.close();
    console.log("HOSTED_MEDIA recovery=PASS pagehide=true resume=true discard=true cap_released=true");
  } finally {
    await browser.close();
  }
}

async function rejectionCase(
  origin: string,
  token: string,
  mode: FakeSession["mode"],
  payload: Uint8Array,
): Promise<void> {
  const session = await createSession(origin, token, payload);
  const fake = fakeFor(session);
  fake.mode = mode;
  await uploadAll(session, payload);
  const response = await expectStatus(sealResponse(origin, token, session.mediaId), 409, `${mode} mismatch seal`);
  const body = await response.json() as { data?: { code?: string } };
  assert(body.data?.code === "media_seal_mismatch", `${mode} mismatch code was not stable`);
  assert(fake.deleted, `${mode} mismatch did not delete the provider file`);
  assert(await countReceipts(session.mediaId) === 0, `${mode} mismatch wrote a receipt`);
}

async function uploadAll(session: SessionResponse, payload: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < payload.length) {
    const end = Math.min(offset + session.partBytes, payload.length);
    const response = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "video/webm", "x-goog-upload-offset": String(offset), "x-goog-upload-command": end === payload.length ? "upload, finalize" : "upload" },
      body: payload.slice(offset, end),
    });
    assert(response.ok, `fixture upload failed at ${offset}: ${response.status}`);
    offset = end;
  }
}

async function createSession(origin: string, token: string, payload: Uint8Array): Promise<SessionResponse> {
  return await (await expectStatus(createResponse(origin, token, payload), 201, "create upload session")).json() as SessionResponse;
}

function createResponse(origin: string, token: string, payload: Uint8Array): Promise<Response> {
  return fetch(`${origin}/api/hosted/media`, {
    method: "POST", headers: mutationHeaders(origin, token),
    body: JSON.stringify({
      declaredSizeBytes: payload.length, declaredSha256: digestHex(payload),
      mimeType: "video/webm", durationSeconds: 3, retention: "ephemeral",
    }),
  });
}

function sealResponse(origin: string, token: string, mediaId: string): Promise<Response> {
  return fetch(`${origin}/api/hosted/media/${mediaId}/seal`, {
    method: "POST", headers: mutationHeaders(origin, token), body: "{}",
  });
}

function janitorResponse(origin: string, token: string): Promise<Response> {
  return fetch(`${origin}/api/hosted/media/janitor`, {
    method: "POST", headers: mutationHeaders(origin, token), body: "{}",
  });
}

async function cancel(origin: string, token: string, mediaId: string): Promise<void> {
  await expectStatus(fetch(`${origin}/api/hosted/media/${mediaId}`, {
    method: "DELETE", headers: mutationHeaders(origin, token), body: "{}",
  }), 200, "cancel upload session");
}

async function openSessions(
  origin: string,
  token: string,
): Promise<Array<{ mediaId: string }>> {
  const response = await expectStatus(fetch(`${origin}/api/hosted/media?state=open`, {
    headers: { "cf-access-jwt-assertion": token },
  }), 200, "list open upload sessions");
  return (await response.json() as { sessions: Array<{ mediaId: string }> }).sessions;
}

function mutationHeaders(origin: string, token: string): Record<string, string> {
  return { "content-type": "application/json", origin, "cf-access-jwt-assertion": token };
}

function fakeFor(session: SessionResponse): FakeSession {
  const id = new URL(session.uploadUrl).searchParams.get("upload_id");
  const fake = id ? sessions.get(id) : undefined;
  if (!fake) throw new Error("Fake provider session was unavailable.");
  return fake;
}

async function expire(mediaId: string): Promise<void> {
  await d1Execute(
    `UPDATE hosted_media_upload_sessions SET session_expires_at = '2020-01-01T00:00:00.000Z' WHERE media_id = '${mediaId}'`,
  );
}

async function uploadState(mediaId: string): Promise<string | undefined> {
  const result = await d1Json(
    `SELECT state FROM hosted_media_upload_sessions WHERE media_id = '${mediaId}'`,
  );
  const state = result[0]?.results?.[0]?.state;
  return typeof state === "string" ? state : undefined;
}

async function countReceipts(mediaId: string): Promise<number> {
  const result = await d1Json(`SELECT count(*) AS value FROM hosted_media_receipts WHERE media_id = '${mediaId}'`);
  const value = result[0]?.results?.[0]?.value;
  if (!Number.isSafeInteger(value)) throw new Error("D1 count was unavailable.");
  return value as number;
}

async function d1Json(command: string): Promise<Array<{ results?: Array<Record<string, unknown>> }>> {
  return JSON.parse(await d1Execute(command, true)) as Array<{ results?: Array<Record<string, unknown>> }>;
}

async function d1Execute(command: string, json = false): Promise<string> {
  return await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName, "--local",
    "--config", configPath, "--persist-to", persistRoot, "--command", command,
    ...(json ? ["--json"] : []),
  ], "query hosted media D1");
}

async function signToken(privateKey: KeyLike, issuer: string, subject: string): Promise<string> {
  return new SignJWT({ sub: subject, email: `${subject}@example.test` })
    .setProtectedHeader({ alg: "RS256", kid: keyId }).setIssuer(issuer)
    .setAudience(audience).setIssuedAt().setExpirationTime("10m").sign(privateKey);
}

function bytes(length: number, seed: number): Uint8Array {
  const value = new Uint8Array(length);
  for (let index = 0; index < value.length; index += 1) value[index] = (index * 31 + seed) % 251;
  return value;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function digestHex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectStatus(responsePromise: Promise<Response> | Response, expected: number, label: string): Promise<Response> {
  const response = await responsePromise;
  if (response.status !== expected) throw new Error(`${label}: expected ${expected}, received ${response.status}: ${await response.text()}`);
  return response;
}

async function runChecked(command: string[], label: string): Promise<string> {
  let last = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const child = Bun.spawn(command, {
      cwd: process.cwd(), env: createE2EEnvironment(process.env), stdin: "ignore",
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    last = `${stdout}\n${stderr}`;
    if (exit === 0) return stdout;
    if (!label.startsWith("query ") || !last.includes("internal error")) break;
    await Bun.sleep(100 * attempt);
  }
  throw new Error(`${label} failed:\n${last}`.slice(0, 20_000));
}

async function reservePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitForWorker(url: string, child: ReturnType<typeof Bun.spawn>, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(url)).status === expected) return; } catch { /* starting */ }
    await Bun.sleep(100);
  }
  throw new Error("Hosted media contract Worker did not become ready.");
}
