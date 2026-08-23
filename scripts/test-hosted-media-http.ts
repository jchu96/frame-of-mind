import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { retryBrowserReadiness } from "./browser-readiness";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { createE2EIsolation } from "../apps/web/e2e/support/isolation";
import { createE2EEnvironment } from "./e2e-environment";
import { analysisDigest } from "../src/domain/integrity";
import type { VersionedAnalysisRun } from "../src/domain/types";
import { resolvePrebuiltWebOutput } from "./prebuilt-artifact";

const isolation = await createE2EIsolation(
  "hosted-media",
  process.env.FRAME_OF_MIND_E2E_TEMP_ROOT,
);
const root = isolation.root;
const persistRoot = isolation.persistRoot;
const configPath = join(root, "wrangler.jsonc");
const databaseName = isolation.databaseName;
const databaseId = isolation.databaseId;
const workerName = isolation.workerName("hosted-media-contract");
const prebuiltOutput = await resolvePrebuiltWebOutput("cloudflare_module");
const webOutput = prebuiltOutput ?? resolve("apps/web/.output");
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
  console.log(`HOSTED_MEDIA isolation=PASS worker=${workerName} database=${databaseName}`);
  console.log("HOSTED_MEDIA build=START cloudflare_module");
  if (prebuiltOutput) {
    console.log("HOSTED_MEDIA build=SKIP prebuilt=cloudflare_module");
  } else {
    await runChecked(
      ["bun", "--no-env-file", "run", "--cwd", "apps/web", "build:cloudflare"],
      "hosted media Cloudflare build",
    );
  }
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
  const port = await isolation.reservePort();
  const origin = `http://127.0.0.1:${port}`;
  await writeFile(configPath, JSON.stringify({
    $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
    name: workerName,
    main: join(webOutput, "server/hosted-entry.mjs"),
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
    assets: { directory: join(webOutput, "public"), binding: "ASSETS" },
    d1_databases: [{
      binding: "DB", database_name: databaseName, database_id: databaseId,
      migrations_dir: resolve("apps/web/db/migrations"),
    }],
    r2_buckets: [{
      binding: "RETAINED_MEDIA",
      bucket_name: "frame-of-mind-hosted-retention-contract",
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
      NUXT_HOSTED_MEDIA_RETENTION_DAYS: "30",
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
  const policyResponse = await expectStatus(fetch(
    `${origin}/api/hosted/media/configuration`,
    { headers: { "cf-access-jwt-assertion": tokenA } },
  ), 200, "hosted media policy");
  const policy = await policyResponse.json() as {
    maxBytes?: number;
    sessionTtlSeconds?: number;
    retentionDays?: number;
  };
  assert(policy.maxBytes === 1024 * 1024, "hosted media policy omitted max bytes");
  assert(policy.sessionTtlSeconds === 3_600, "hosted media policy omitted upload session TTL");
  assert(policy.retentionDays === 30, "hosted media policy omitted R2 retention days");
  console.log("HOSTED_MEDIA policy=PASS session_ttl=3600 retention_days=30");

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
  const ephemeralRunId = "20260823T055900Z-hosted-ephemeral-contract";
  await seedEvidenceRun(ephemeralRunId, direct.mediaId, digestHex(recording));
  await browserEphemeralDisclosureContract(origin, tokenA, ephemeralRunId);

  await rejectionCase(origin, tokenA, "size", bytes(330_001, 31));
  await rejectionCase(origin, tokenA, "digest", bytes(330_002, 32));
  await rejectionCase(origin, tokenA, "missing", bytes(330_003, 33));
  console.log("HOSTED_MEDIA mismatch=PASS size=true same_size_digest=true missing_hash=true deleted=true");

  const boundedRetainedBytes = bytes(700_301, 89);
  const boundedRetained = await createSession(origin, tokenA, boundedRetainedBytes, "retained");
  assert(boundedRetained.retainedUpload, "bounded retained fixture omitted capability");
  const boundedPrefix = boundedRetainedBytes.slice(0, 400_000);
  const boundedPart = await uploadRetainedPart(
    boundedRetained.retainedUpload.partUrl,
    1,
    boundedPrefix,
    tokenA,
  );
  const oversizedPart = await expectStatus(
    uploadRetainedPartResponse(
      boundedRetained.retainedUpload.partUrl,
      1,
      boundedRetainedBytes,
      tokenA,
    ),
    422,
    "retained part beyond declared cumulative bytes",
  );
  assert(
    (await oversizedPart.json() as { data?: { code?: string } }).data?.code
      === "hosted_retained_part_size_exceeded",
    "retained part ceiling did not return its stable code",
  );
  assert(
    await retainedUploadedBytes(boundedRetained.mediaId) === boundedPrefix.length,
    "rejected retained part changed the D1 byte counter",
  );
  await expectStatus(fetch(boundedRetained.retainedUpload.completeUrl, {
    method: "POST",
    headers: mutationHeaders(origin, tokenA),
    body: JSON.stringify({ parts: [boundedPart] }),
  }), 200, "complete retained object after rejected overwrite");
  await cancel(origin, tokenA, boundedRetained.mediaId);

  const concurrentRetainedBytes = bytes(700_311, 90);
  const concurrentRetained = await createSession(origin, tokenA, concurrentRetainedBytes, "retained");
  assert(concurrentRetained.retainedUpload, "concurrent retained fixture omitted capability");
  const concurrentPayload = concurrentRetainedBytes.slice(0, 400_000);
  const concurrentResponses = await Promise.all([
    uploadRetainedPartResponse(concurrentRetained.retainedUpload.partUrl, 1, concurrentPayload, tokenA),
    uploadRetainedPartResponse(concurrentRetained.retainedUpload.partUrl, 2, concurrentPayload, tokenA),
  ]);
  assert(
    concurrentResponses.map((response) => response.status).sort().join(",") === "200,422",
    "concurrent retained parts were not bounded by one D1 CAS",
  );
  const concurrentRejected = concurrentResponses.find((response) => response.status === 422);
  assert(
    (await concurrentRejected?.json() as { data?: { code?: string } } | undefined)?.data?.code
      === "hosted_retained_part_size_exceeded",
    "concurrent retained rejection omitted its stable code",
  );
  assert(
    await retainedUploadedBytes(concurrentRetained.mediaId) === concurrentPayload.length,
    "concurrent retained parts overshot the declared D1 byte counter",
  );
  await cancel(origin, tokenA, concurrentRetained.mediaId);

  const retainedBytes = bytes(700_321, 91);
  const retained = await createSession(origin, tokenA, retainedBytes, "retained");
  assert(retained.retainedUpload, "retained create omitted its R2 capability");
  assert(!JSON.stringify(retained.retainedUpload).includes(fixtureKey), "retained capability leaked Gemini key");
  await uploadAll(retained, retainedBytes);
  await uploadAllRetained(retained, retainedBytes, tokenA);
  await expectStatus(
    uploadRetainedPartResponse(retained.retainedUpload.partUrl, 1, retainedBytes, tokenA),
    409,
    "completed retained capability reuse",
  );
  const retainedSeal = await expectStatus(sealResponse(origin, tokenA, retained.mediaId), 200, "retained exact seal");
  const retainedBody = await retainedSeal.json() as { media?: { keptUntil?: string; playbackAvailable?: boolean } };
  assert(Boolean(retainedBody.media?.keptUntil), "retained seal omitted kept-until");
  assert(retainedBody.media?.playbackAvailable === true, "retained seal omitted playback availability");
  const retainedRow = await d1Json(`SELECT retained_object_key FROM hosted_media_receipts WHERE media_id = '${retained.mediaId}'`);
  const retainedKey = retainedRow[0]?.results?.[0]?.retained_object_key;
  assert(typeof retainedKey === "string" && /^principals\/[a-f0-9]{32}\/media\/[a-f0-9-]{36}$/.test(retainedKey), "retained object key was not principal-scoped and unguessable");
  await expectStatus(deleteRetainedResponse(origin, tokenB, retained.mediaId), 404, "cross-principal retained delete");
  const retainedAttemptId = await seedActiveRetainedJob(retained.mediaId);
  const inUseDelete = await expectStatus(
    deleteRetainedResponse(origin, tokenA, retained.mediaId),
    409,
    "retained delete while hosted job is active",
  );
  assert(
    (await inUseDelete.json() as { data?: { code?: string } }).data?.code
      === "hosted_retained_media_in_use",
    "active-job retained delete did not return its stable code",
  );
  await d1Execute(`UPDATE hosted_analysis_attempts SET stage = 'succeeded' WHERE attempt_id = ${sql(retainedAttemptId)}`);
  await expectStatus(deleteRetainedResponse(origin, tokenA, retained.mediaId), 200, "explicit retained delete");

  const mismatchedRetainedBytes = bytes(700_333, 92);
  const mismatchedRetained = await createSession(origin, tokenA, mismatchedRetainedBytes, "retained");
  await uploadAll(mismatchedRetained, mismatchedRetainedBytes);
  await uploadAllRetained(mismatchedRetained, bytes(mismatchedRetainedBytes.length, 93), tokenA);
  const retainedMismatch = await expectStatus(
    sealResponse(origin, tokenA, mismatchedRetained.mediaId),
    409,
    "retained object with wrong bytes is rejected",
  );
  assert(
    (await retainedMismatch.json() as { data?: { code?: string } }).data?.code === "retained_media_seal_mismatch",
    "retained digest mismatch did not return its stable code",
  );

  const expiringRetainedBytes = bytes(700_345, 94);
  const expiringRetained = await createSession(origin, tokenA, expiringRetainedBytes, "retained");
  await uploadAll(expiringRetained, expiringRetainedBytes);
  await uploadAllRetained(expiringRetained, expiringRetainedBytes, tokenA);
  await expectStatus(sealResponse(origin, tokenA, expiringRetained.mediaId), 200, "retained lifecycle seal");
  await d1Execute(`UPDATE hosted_media_receipts SET retained_until = '2020-01-01T00:00:00.000Z' WHERE media_id = '${expiringRetained.mediaId}'`);
  const lifecycleSweep = await expectStatus(janitorResponse(origin, tokenA), 200, "retained lifecycle janitor");
  assert((await lifecycleSweep.json() as { retained?: number }).retained === 1, "retained lifecycle object was not swept");

  const orphanBytes = bytes(700_357, 95);
  const orphan = await createSession(origin, tokenA, orphanBytes, "retained");
  assert(orphan.retainedUpload, "orphan fixture omitted retained capability");
  await uploadRetainedPart(orphan.retainedUpload.partUrl, 1, orphanBytes, tokenA);
  await expire(orphan.mediaId);
  const orphanSweep = await expectStatus(janitorResponse(origin, tokenA), 200, "retained orphan janitor");
  assert((await orphanSweep.json() as { abandoned?: number }).abandoned === 1, "retained orphan was not abandoned");
  await expectStatus(uploadRetainedPartResponse(orphan.retainedUpload.partUrl, 1, orphanBytes, tokenA), 409, "swept retained capability reuse");
  console.log("HOSTED_RETENTION_CONTRACT PASSED presign=true multipart=true part_ceiling=true concurrent_cas=true digest_match=true digest_mismatch=true lifecycle=true delete=true in_use_delete=true orphan=true isolation=true");

  const evidenceBytes = bytes(700_369, 96);
  const evidenceMedia = await createSession(origin, tokenA, evidenceBytes, "retained");
  await uploadAll(evidenceMedia, evidenceBytes);
  await uploadAllRetained(evidenceMedia, evidenceBytes, tokenA);
  await expectStatus(sealResponse(origin, tokenA, evidenceMedia.mediaId), 200, "evidence retained seal");
  const evidenceRunId = "20260823T060000Z-hosted-evidence-contract";
  await seedEvidenceRun(evidenceRunId, evidenceMedia.mediaId, digestHex(evidenceBytes));
  const evidenceSourceResponse = await expectStatus(fetch(
    `${origin}/api/hosted/runs/${evidenceRunId}/evidence`,
    { headers: { "cf-access-jwt-assertion": tokenA } },
  ), 200, "evidence source");
  const evidenceSource = await evidenceSourceResponse.json() as {
    source: { manifestSha256: string; recordingSha256: string };
    evidence: unknown[];
  };
  assert(evidenceSource.evidence.length === 0, "new evidence list was not empty");
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await expectStatus(captureResponse(origin, tokenA, evidenceRunId, png, {}), 422, "capture without source/timestamp is refused");
  await expectStatus(captureResponse(origin, tokenA, evidenceRunId, png, {
    timestampSeconds: 2.5,
    manifestSha256: "0".repeat(64),
    recordingSha256: evidenceSource.source.recordingSha256,
  }), 422, "capture with false manifest source");
  const captured = await expectStatus(captureResponse(origin, tokenA, evidenceRunId, png, {
    timestampSeconds: 3.5,
    manifestSha256: evidenceSource.source.manifestSha256,
    recordingSha256: evidenceSource.source.recordingSha256,
  }), 201, "capture with exact provenance");
  const capturedBody = await captured.json() as { evidence?: { timestampSeconds?: number; source?: { manifestSha256?: string; recordingSha256?: string } } };
  assert(capturedBody.evidence?.timestampSeconds === 3, "capture timestamp was not clamped to media duration");
  assert(capturedBody.evidence?.source?.manifestSha256 === evidenceSource.source.manifestSha256, "capture omitted manifest source provenance");
  assert(capturedBody.evidence?.source?.recordingSha256 === evidenceSource.source.recordingSha256, "capture omitted recording source provenance");
  await browserEvidenceCaptureContract(origin, tokenA, evidenceRunId, png);
  await expectStatus(fetch(`${origin}/api/hosted/runs/${evidenceRunId}/evidence`, {
    headers: { "cf-access-jwt-assertion": tokenB },
  }), 404, "cross-principal evidence list");
  await expectStatus(deleteRetainedResponse(origin, tokenA, evidenceMedia.mediaId), 200, "evidence source delete");
  const deletedEvidence = await d1Json(`SELECT count(*) AS value FROM hosted_evidence_captures WHERE media_id = '${evidenceMedia.mediaId}'`);
  assert(deletedEvidence[0]?.results?.[0]?.value === 0, "retained delete left evidence receipts behind");
  await expectStatus(fetch(`${origin}/api/hosted/runs/${evidenceRunId}/evidence`, {
    headers: { "cf-access-jwt-assertion": tokenA },
  }), 404, "evidence list after retained delete");
  console.log("HOSTED_EVIDENCE_CONTRACT PASSED canvas_e2e=true timestamp=true manifest_source=true recording_source=true refusal_code=true isolation=true");

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
  await isolation.cleanup();
}

interface SessionResponse {
  mediaId: string;
  uploadUrl: string;
  partBytes: number;
  sessionExpiresAt: string;
  retainedUpload?: { partUrl: string; completeUrl: string };
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

async function launchReadyBrowser(origin: string, token: string) {
  return await retryBrowserReadiness(async (attempt) => {
    const browser = await chromium.launch({ headless: true, timeout: 30_000 });
    try {
      const context = await browser.newContext({
        extraHTTPHeaders: { "cf-access-jwt-assertion": token },
      });
      try {
        const page = await context.newPage();
        const response = await page.goto(`${origin}/api/health`);
        if (!response?.ok()) {
          throw new Error(
            `Hosted media browser readiness failed with ${response?.status() ?? "no response"}.`,
          );
        }
      } finally {
        await context.close().catch(() => undefined);
      }
      if (!browser.isConnected()) {
        throw new Error("Browser has been closed during hosted media readiness.");
      }
      console.log(`HOSTED_MEDIA browser_readiness=PASS attempts=${attempt}`);
      return browser;
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }, ({ attempt }) => {
    console.log(`HOSTED_MEDIA browser_readiness=RETRY attempt=${attempt}`);
  });
}

async function browserResumeContract(
  origin: string,
  token: string,
  session: SessionResponse,
  payload: Uint8Array,
): Promise<void> {
  const browser = await launchReadyBrowser(origin, token);
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

  const browser = await launchReadyBrowser(origin, token);
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
      "Choose the same recording to continue this upload.",
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
    await second.getByText("Choose the same recording to continue this upload.").waitFor();
    assert(
      recoveryFake.queryCount > queriesBeforeResume,
      "Resume did not query the authoritative provider offset",
    );
    await second.getByRole("button", { name: "Cancel upload" }).click();
    await second.getByText("Upload cancelled").waitFor();
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

async function browserEvidenceCaptureContract(
  origin: string,
  token: string,
  runId: string,
  png: Uint8Array,
): Promise<void> {
  const browser = await launchReadyBrowser(origin, token);
  try {
    const context = await browser.newContext({
      extraHTTPHeaders: { "cf-access-jwt-assertion": token },
    });
    const page = await context.newPage();
    await page.addInitScript((encoded) => {
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", { get: () => 4 });
      Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { get: () => 1 });
      Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { get: () => 1 });
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { get: () => 2.75, set: () => undefined });
      CanvasRenderingContext2D.prototype.drawImage = () => undefined;
      HTMLCanvasElement.prototype.toBlob = function (callback) {
        const raw = atob(encoded);
        callback(new Blob([Uint8Array.from(raw, (value) => value.charCodeAt(0))], { type: "image/png" }));
      };
    }, Buffer.from(png).toString("base64"));
    await page.goto(`${origin}/review/${runId}`);
    const button = page.getByRole("button", { name: "Capture current frame" });
    await button.waitFor();
    await button.click();
    await page.getByText("2.750s").waitFor();
    assert(await page.locator("[data-hosted-ephemeral-disclosure]").count() === 0, "retained review showed ephemeral disclosure");
    await context.close();
  } finally {
    await browser.close();
  }
}

async function browserEphemeralDisclosureContract(
  origin: string,
  token: string,
  runId: string,
): Promise<void> {
  const browser = await launchReadyBrowser(origin, token);
  try {
    const context = await browser.newContext({
      extraHTTPHeaders: { "cf-access-jwt-assertion": token },
    });
    const page = await context.newPage();
    await page.goto(`${origin}/review/${runId}`);
    await page.locator("[data-hosted-ephemeral-disclosure]").waitFor();
    assert(await page.locator("video").count() === 0, "ephemeral review exposed playback");
    assert(await page.getByRole("button", { name: "Capture current frame" }).count() === 0, "ephemeral review exposed capture");
    await context.close();
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

async function createSession(origin: string, token: string, payload: Uint8Array, retention: "ephemeral" | "retained" = "ephemeral"): Promise<SessionResponse> {
  return await (await expectStatus(createResponse(origin, token, payload, retention), 201, "create upload session")).json() as SessionResponse;
}

function createResponse(origin: string, token: string, payload: Uint8Array, retention: "ephemeral" | "retained" = "ephemeral"): Promise<Response> {
  return fetch(`${origin}/api/hosted/media`, {
    method: "POST", headers: mutationHeaders(origin, token),
    body: JSON.stringify({
      declaredSizeBytes: payload.length, declaredSha256: digestHex(payload),
      mimeType: "video/webm", durationSeconds: 3, retention,
    }),
  });
}

async function uploadAllRetained(session: SessionResponse, payload: Uint8Array, token: string): Promise<void> {
  if (!session.retainedUpload) throw new Error("retained upload capability missing");
  const part = await uploadRetainedPart(session.retainedUpload.partUrl, 1, payload, token);
  await expectStatus(fetch(session.retainedUpload.completeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(session.retainedUpload.completeUrl).origin, "cf-access-jwt-assertion": token },
    body: JSON.stringify({ parts: [part] }),
  }), 200, "complete retained multipart upload");
}

async function uploadRetainedPart(url: string, partNumber: number, payload: Uint8Array, token: string): Promise<{ partNumber: number; etag: string }> {
  const response = await expectStatus(uploadRetainedPartResponse(url, partNumber, payload, token), 200, "upload retained part");
  return await response.json() as { partNumber: number; etag: string };
}

function uploadRetainedPartResponse(url: string, partNumber: number, payload: Uint8Array, token: string): Promise<Response> {
  const separator = url.includes("?") ? "&" : "?";
  return fetch(`${url}${separator}partNumber=${partNumber}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", origin: new URL(url).origin, "cf-access-jwt-assertion": token },
    body: payload,
  });
}

function deleteRetainedResponse(origin: string, token: string, mediaId: string): Promise<Response> {
  return fetch(`${origin}/api/hosted/media/${mediaId}/retained`, {
    method: "DELETE", headers: mutationHeaders(origin, token), body: "{}",
  });
}

async function retainedUploadedBytes(mediaId: string): Promise<number | undefined> {
  const rows = await d1Json(
    `SELECT r2_uploaded_bytes FROM hosted_media_upload_sessions WHERE media_id = ${sql(mediaId)}`,
  );
  const value = rows[0]?.results?.[0]?.r2_uploaded_bytes;
  return typeof value === "number" ? value : undefined;
}

function captureResponse(
  origin: string,
  token: string,
  runId: string,
  png: Uint8Array,
  provenance: { timestampSeconds?: number; manifestSha256?: string; recordingSha256?: string },
): Promise<Response> {
  const query = provenance.timestampSeconds === undefined
    ? ""
    : `?timestampSeconds=${provenance.timestampSeconds}`;
  return fetch(`${origin}/api/hosted/runs/${runId}/evidence${query}`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      origin,
      "cf-access-jwt-assertion": token,
      ...(provenance.manifestSha256
        ? { "x-fom-source-manifest-sha256": provenance.manifestSha256 }
        : {}),
      ...(provenance.recordingSha256
        ? { "x-fom-source-recording-sha256": provenance.recordingSha256 }
        : {}),
    },
    body: png,
  });
}

async function seedEvidenceRun(runId: string, mediaId: string, recordingSha256: string): Promise<void> {
  const analysis: VersionedAnalysisRun = {
    schemaVersion: 3,
    runId,
    recipe: { id: "issue-review", label: "Issue review" },
    context: { mode: "none" },
    model: "gemini-test",
    matchNotes: "Hosted evidence contract.",
    items: [{
      candidate: { start: "00:00:02", end: "00:00:03", summary: "Visible evidence.", kind: "issue", importance: "high" },
      result: { accepted: true, kind: "issue", title: "Visible issue", summary: "The recording shows the issue.", importance: "high", evidence: { timestamp: "00:00:02" } },
    }],
  };
  const manifest = {
    schemaVersion: 3,
    toolVersion: "0.3.0",
    promptRevision: "contract",
    runId,
    startedAt: "2026-08-23T06:00:00.000Z",
    completedAt: "2026-08-23T06:01:00.000Z",
    context: { mode: "none" },
    recipe: { id: "issue-review", label: "Issue review", custom: false, revision: "contract", sha256: "c".repeat(64) },
    model: "gemini-test",
    recordingSha256,
    analysisSha256: await analysisDigest(analysis),
    recordingMimeType: "video/webm",
    mediaSource: "local-file",
    remoteFile: { deleted: true },
    analysis: { maxIncidents: 3, indexFps: 0.5, indexResolution: "low", interrogationResolution: "medium" },
    artifacts: ["analysis.json", "manifest.json"],
  };
  const principal = "media-principal-a";
  const suffix = createHash("sha256").update(runId).digest("hex").slice(0, 20);
  const jobId = `job_${suffix}`;
  const attemptId = `attempt_${suffix}`;
  const timestamp = "2026-08-23T06:01:00.000Z";
  await d1Execute(`INSERT INTO video_analysis_runs (principal_sub, run_id, principal_email, recipe_id, recipe_label, model, started_at, completed_at, match_notes, accepted_count, rejected_count, analysis_json, manifest_json, imported_at, imported_by) VALUES (${sql(principal)}, ${sql(runId)}, 'media-principal-a@example.test', 'issue-review', 'Issue review', 'gemini-test', '2026-08-23T06:00:00.000Z', ${sql(timestamp)}, 'Hosted evidence contract.', 1, 0, ${sql(JSON.stringify(analysis))}, ${sql(JSON.stringify(manifest))}, ${sql(timestamp)}, 'contract')`);
  await d1Execute(`INSERT INTO analysis_run_registry (principal_sub, run_id, principal_email, schema_version) VALUES (${sql(principal)}, ${sql(runId)}, 'media-principal-a@example.test', 3)`);
  await d1Execute(`INSERT INTO hosted_analysis_jobs (principal_sub, job_id, principal_email, media_id, created_at) VALUES (${sql(principal)}, ${sql(jobId)}, 'media-principal-a@example.test', ${sql(mediaId)}, ${sql(timestamp)})`);
  await d1Execute(`INSERT INTO hosted_analysis_attempts (principal_sub, attempt_id, job_id, attempt_number, idempotency_key, workflow_instance_id, immutable_input_json, stage, spend_reserved_units, run_id, cleanup_completed_at, created_at, updated_at) VALUES (${sql(principal)}, ${sql(attemptId)}, ${sql(jobId)}, 1, ${sql(`evidence-contract-${suffix}`)}, ${sql(`workflow-${suffix}`)}, '{}', 'succeeded', 1, ${sql(runId)}, ${sql(timestamp)}, ${sql(timestamp)}, ${sql(timestamp)})`);
}

async function seedActiveRetainedJob(mediaId: string): Promise<string> {
  const suffix = createHash("sha256").update(`active:${mediaId}`).digest("hex").slice(0, 20);
  const jobId = `job_${suffix}`;
  const attemptId = `attempt_${suffix}`;
  const timestamp = "2026-08-23T06:00:00.000Z";
  await d1Execute(`INSERT INTO hosted_analysis_jobs (principal_sub, job_id, principal_email, media_id, created_at) VALUES ('media-principal-a', ${sql(jobId)}, 'media-principal-a@example.test', ${sql(mediaId)}, ${sql(timestamp)})`);
  await d1Execute(`INSERT INTO hosted_analysis_attempts (principal_sub, attempt_id, job_id, attempt_number, idempotency_key, workflow_instance_id, immutable_input_json, stage, spend_reserved_units, created_at, updated_at) VALUES ('media-principal-a', ${sql(attemptId)}, ${sql(jobId)}, 1, ${sql(`retained-delete-${suffix}`)}, ${sql(`workflow-${suffix}`)}, '{}', 'queued', 1, ${sql(timestamp)}, ${sql(timestamp)})`);
  return attemptId;
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

async function waitForWorker(url: string, child: ReturnType<typeof Bun.spawn>, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(url)).status === expected) return; } catch { /* starting */ }
    await Bun.sleep(100);
  }
  throw new Error("Hosted media contract Worker did not become ready.");
}
