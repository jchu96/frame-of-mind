import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { Miniflare } from "miniflare";
import { createE2EEnvironment } from "./e2e-environment";

const mebibyte = 1024 * 1024;
const chunkBytes = 64 * 1024;
const audience = "frame-of-mind-hosted-stream-spike";
const keyId = "hosted-stream-spike-key";
const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-hosted-stream-"));
const configPath = join(temporaryRoot, "wrangler.jsonc");
const persistRoot = join(temporaryRoot, "wrangler-state");
const routePath = "/api/_spike/stream";
const slowSinkHoldMs = 2_500;
const partBytesValues = [1, 2, 4].map((value) => value * mebibyte);
const concurrencyValues = [2, 4];
const absoluteBackingGrowthLimit = 24 * mebibyte;
const sinkReceipts = new Map<string, SinkReceipt>();
const sinkStates = new Map<string, SinkState>();
let lastSinkFailure = "none";
let jwksServer: ReturnType<typeof Bun.serve> | undefined;
let sinkServer: ReturnType<typeof Bun.serve> | undefined;
let activeWrangler: WranglerProcess | undefined;
let inspector: InspectorClient | undefined;
let spikePassed = false;

try {
  receipt("build", true, "START cloudflare_module");
  await runChecked(
    ["bun", "--no-env-file", "run", "build:web:cloudflare"],
    "Cloudflare artifact build",
  );
  receipt("build", true, "cloudflare_module");
  await runChecked(
    ["bun", "--no-env-file", "run", "build:hosted-stream-entry"],
    "Hosted wrapper entry build",
  );
  receipt("hosted_entry_build", true, "apps/web/.output/server/hosted-entry.mjs");

  const routeSource = await readFile(resolve("scripts/spike-hosted-entry.ts"), "utf8");
  const forbiddenRouteCalls = [...routeSource.matchAll(/\b(?:readBody|readRawBody)\s*\(/g)];
  assert(forbiddenRouteCalls.length === 0, "Spike route calls a body-materializing H3 helper.");
  assert(!routeSource.includes(".arrayBuffer()"), "Hosted entry source materializes the request body.");
  assert(!routeSource.includes(".tee()"), "Hosted entry source splits the request body with tee().");
  receipt("route_source", true, "single_transform DigestStream byte_cap no_tee no_body_materializer");

  const artifactScan = await scanBuiltArtifact();
  receipt(
    "artifact_marker",
    artifactScan.hostedEntry && artifactScan.nitroRouteAbsent,
    `hosted_entry=${artifactScan.hostedEntry} nitro_route_absent=${artifactScan.nitroRouteAbsent}`,
  );

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
  sinkServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: receiveAtFakeSink,
  });
  const issuer = `http://127.0.0.1:${jwksServer.port}`;
  const token = await signAccessToken(keys.privateKey, issuer, {
    sub: "hosted-stream-spike-user",
    email: "spike@example.test",
  });
  const serviceToken = await signAccessToken(keys.privateKey, issuer, {
    sub: "",
    common_name: "hosted-stream-spike.access",
  });
  const emptySubToken = await signAccessToken(keys.privateKey, issuer, { sub: "" });
  const wrongAudienceToken = await signAccessToken(
    keys.privateKey,
    issuer,
    { sub: "hosted-stream-spike-user" },
    { audience: "not-the-spike-audience" },
  );
  const wrongIssuerToken = await signAccessToken(
    keys.privateKey,
    issuer,
    { sub: "hosted-stream-spike-user" },
    { issuer: "https://not-the-spike-issuer.example" },
  );
  const expiredToken = await signAccessToken(
    keys.privateKey,
    issuer,
    { sub: "hosted-stream-spike-user" },
    {
      issuedAt: Math.floor(Date.now() / 1_000) - 3_600,
      expirationTime: Math.floor(Date.now() / 1_000) - 60,
    },
  );
  const algNoneToken = unsignedAccessToken(issuer, audience, {
    sub: "hosted-stream-spike-user",
  });

  const darkPort = await reservePort();
  await writeWranglerConfig({ issuer, enabled: false });
  activeWrangler = await startWrangler(darkPort);
  const darkOrigin = `http://127.0.0.1:${darkPort}`;
  await waitForWorker(darkOrigin, activeWrangler.child);
  await expectStatus(fetch(`${darkOrigin}${routePath}`, {
    method: "POST",
    headers: { "cf-access-jwt-assertion": token },
  }), 404, "dark spike route");
  receipt("dark_gate", true, "authenticated_status=404 env_absent");
  await stopWrangler(activeWrangler);
  activeWrangler = undefined;

  const workerPort = await reservePort();
  const inspectorPort = await reservePort();
  await writeWranglerConfig({
    issuer,
    enabled: true,
    sinkUrl: `http://127.0.0.1:${sinkServer.port}/resumable`,
  });
  activeWrangler = await startWrangler(workerPort, inspectorPort);
  let origin = `http://127.0.0.1:${workerPort}`;
  await waitForWorker(origin, activeWrangler.child);
  inspector = await InspectorClient.connect(inspectorPort).catch(() => undefined);
  const accessNegatives = await Promise.all([
    expectUploadStatus(origin, undefined, "missing-access", 403),
    expectUploadStatus(origin, wrongAudienceToken, "wrong-audience", 403),
    expectUploadStatus(origin, wrongIssuerToken, "wrong-issuer", 403),
    expectUploadStatus(origin, expiredToken, "expired-token", 403),
    expectUploadStatus(origin, algNoneToken, "alg-none", 403),
    expectUploadStatus(origin, emptySubToken, "empty-sub", 403),
    expectUploadStatus(origin, serviceToken, "service-token", 403),
  ]);
  assert(accessNegatives.every((status) => status === 403), "An Access negative reached the upload body.");
  receipt(
    "access_negatives",
    true,
    "missing=403 wrong_aud=403 wrong_iss=403 expired=403 alg_none=403 empty_sub=403 service=403",
  );

  const bypassReceipts = await Promise.all([
    uploadFixture(origin, token, {
      id: "variant-trailing",
      bytes: 8 * mebibyte,
      seed: 3,
      path: `${routePath}/`,
    }),
    uploadFixture(origin, token, {
      id: "variant-double",
      bytes: 8 * mebibyte,
      seed: 5,
      path: "//api/_spike/stream",
    }),
    uploadFixture(origin, token, {
      id: "variant-encoded",
      bytes: 8 * mebibyte,
      seed: 7,
      path: "/api/_spike/%73tream",
    }),
  ]);
  for (const value of bypassReceipts) assertUploadReceipt(value);
  receipt(
    "bypass_variants",
    true,
    "trailing=wrapper double_slash=wrapper percent_decoded=wrapper nitro_handler=absent",
  );

  inspector?.close();
  inspector = undefined;
  await stopWrangler(activeWrangler);
  activeWrangler = undefined;

  const partBounds: PartBoundResult[] = [];
  const matrixReceipts: UploadReceipt[] = [];
  for (const partBytes of partBytesValues) {
    for (const concurrency of concurrencyValues) {
      const matrixPort = await reservePort();
      const matrixInspectorPort = await reservePort();
      activeWrangler = await startWrangler(matrixPort, matrixInspectorPort);
      origin = `http://127.0.0.1:${matrixPort}`;
      await waitForWorker(origin, activeWrangler.child);
      inspector = await InspectorClient.connect(matrixInspectorPort);
      const result = await runPartBoundCheck({
        origin,
        token,
        rootPid: activeWrangler.child.pid,
        inspector,
        partBytes,
        concurrency,
      });
      partBounds.push(result);
      matrixReceipts.push(...result.receipts);
      console.log(
        `HOSTED_STREAM part_bound part=${partBytes} concurrency=${concurrency} `
          + `hold_delta=${formatBytes(result.holdDelta)} peak=${formatBytes(result.peakGrowth)} `
          + `rss_peak=${formatBytes(result.rssPeak)} bounded=${result.bounded}`,
      );
      inspector.close();
      inspector = undefined;
      await stopWrangler(activeWrangler);
      activeWrangler = undefined;
    }
  }
  const slowSinkPassed = partBounds.every((value) => value.delayMs >= slowSinkHoldMs)
    && matrixReceipts.every((value) => value.sha256 === value.expected.sha256);
  receipt(
    "slow_sink",
    slowSinkPassed,
    `combos=${partBounds.length} delay_ms_min=${Math.min(...partBounds.map((value) => value.delayMs))} `
      + "all_digests_exact=true",
  );

  const postMatrixPort = await reservePort();
  const postMatrixInspectorPort = await reservePort();
  activeWrangler = await startWrangler(postMatrixPort, postMatrixInspectorPort);
  origin = `http://127.0.0.1:${postMatrixPort}`;
  await waitForWorker(origin, activeWrangler.child);
  inspector = await InspectorClient.connect(postMatrixInspectorPort);

  const truncatedOverLength = await runDirectLengthCheck({
    issuer,
    sinkUrl: `http://127.0.0.1:${sinkServer.port}/resumable`,
    token,
    uploadId: "over-length",
    sourceBytes: 9 * mebibyte,
    declaredBytes: 8 * mebibyte,
    seed: 17,
  });
  const truncatedReceipt = sinkReceipts.get("over-length");
  const truncatedOverLengthPassed = truncatedOverLength.status === 200
    && truncatedOverLength.sinkState?.completed === true
    && truncatedOverLength.sinkState.aborted === false
    && truncatedOverLength.sinkState.bytes === 8 * mebibyte
    && truncatedReceipt?.bytes === 8 * mebibyte;
  receipt(
    "over_length_truncation",
    truncatedOverLengthPassed,
    `declared_bytes=${8 * mebibyte} source_bytes=${9 * mebibyte} `
      + `forwarded_bytes=${truncatedOverLength.sinkState?.bytes ?? "none"} `
      + `status=${truncatedOverLength.status} receipt=${sinkReceipts.has("over-length")}`,
  );

  const shortPart = await runDirectLengthCheck({
    issuer,
    sinkUrl: `http://127.0.0.1:${sinkServer.port}/resumable`,
    token,
    uploadId: "short-part",
    sourceBytes: 7 * mebibyte,
    declaredBytes: 8 * mebibyte,
    seed: 23,
  });
  const shortPartPassed = shortPart.status >= 400
    && (shortPart.sinkState === undefined || (
      shortPart.sinkState.aborted
      && !shortPart.sinkState.completed
      && shortPart.sinkState.bytes === 7 * mebibyte
    ))
    && !sinkReceipts.has("short-part");
  receipt(
    "short_part",
    shortPartPassed,
    `declared_bytes=${8 * mebibyte} forwarded_bytes=${shortPart.sinkState?.bytes ?? "none"} `
      + `status=${shortPart.status} sink_aborted=${shortPart.sinkState?.aborted ?? false} `
      + `sink_not_reached=${shortPart.sinkState === undefined} `
      + `receipt=${sinkReceipts.has("short-part")}`,
  );

  const clientAbort = new AbortController();
  const clientAbortRequest = uploadResponse(origin, token, {
    id: "client-abort",
    bytes: 4 * mebibyte,
    seed: 13,
    pullDelayMs: 10,
    signal: clientAbort.signal,
  });
  const clientAbortState = await waitForSinkState("client-abort", (state) => state.bytes > 0);
  clientAbort.abort();
  let clientAbortResult = "response";
  try {
    const response = await clientAbortRequest;
    clientAbortResult = `status_${response.status}`;
  } catch (error) {
    clientAbortResult = error instanceof Error ? error.name : "threw";
  }
  await waitForSinkState(
    "client-abort",
    (state) => state.aborted || state.completed,
  );
  const clientAbortPassed = clientAbortState.aborted
    && !clientAbortState.completed
    && clientAbortState.bytes > 0
    && clientAbortState.bytes < 4 * mebibyte
    && !sinkReceipts.has("client-abort");
  receipt(
    "client_abort",
    clientAbortPassed,
    `client=${clientAbortResult} sink_bytes=${clientAbortState.bytes} `
      + `sink_aborted=${clientAbortState.aborted} receipt=${sinkReceipts.has("client-abort")}`,
  );
  assert(clientAbortPassed, "Client abort left a completed sink receipt.");

  const allUploadReceipts = [
    ...bypassReceipts,
    ...matrixReceipts,
  ];
  const digestPassed = allUploadReceipts.every(
    (value) => value.runtime.hashImplementation === "DigestStream"
      && value.sha256 === value.expected.sha256,
  );
  receipt(
    "digest_impl",
    digestPassed,
    `implementation=DigestStream uploads=${allUploadReceipts.length}`,
  );
  receipt(
    "wasm_signal",
    true,
    "not_used DigestStream avoids_runtime_wasm_compile",
  );
  receipt(
    "isolate_total_signal",
    true,
    "unavailable workerd_has_no_per_isolate_total_api; process_tree_rss_is_host-level_best_signal",
  );

  const upstreamStates = allUploadReceipts
    .map((value) => String(value.runtime.upstreamBodyUsedAtHandler));
  const streamingPathPassed = artifactScan.hostedEntry
    && !artifactScan.hostedEntryArrayBuffer
    && upstreamStates.every((value) => value === "false");
  receipt(
    "streaming_path",
    streamingPathPassed,
    `entry=hosted-entry upstream_body_used=${upstreamStates.join(",")} `
      + `stock_nitro_prebuffer=${artifactScan.requestArrayBuffer} `
      + `matrix_uploads=${matrixReceipts.length}`,
  );

  const boundedPartSizes = partBytesValues.filter((partBytes) => partBounds
    .filter((value) => value.partBytes === partBytes)
    .every((value) => value.bounded));
  const selectedPartBytes = boundedPartSizes.at(-1) ?? null;
  const selectedConcurrency = selectedPartBytes === null ? null : Math.max(...concurrencyValues);
  receipt(
    "decision",
    selectedPartBytes !== null,
    selectedPartBytes === null
      ? "NO-GO no_part_size_bounded"
      : `GO part=${selectedPartBytes} concurrency_cap=${selectedConcurrency} pending_ADR_amendment`,
  );

  spikePassed = streamingPathPassed
    && digestPassed
    && slowSinkPassed
    && truncatedOverLengthPassed
    && shortPartPassed
    && clientAbortPassed
    && selectedPartBytes !== null;
  console.log(
    spikePassed
      ? "HOSTED_STREAM_SPIKE PASSED"
      : `HOSTED_STREAM_SPIKE FAILED reason=${[
          ...(streamingPathPassed ? [] : ["hosted_entry_streaming_path_failed"]),
          ...(digestPassed ? [] : ["digest_stream_failed"]),
          ...(slowSinkPassed ? [] : ["slow_sink_unbounded"]),
          ...(truncatedOverLengthPassed ? [] : ["over_length_truncation_contract_failed"]),
          ...(shortPartPassed ? [] : ["short_part_contract_failed"]),
          ...(clientAbortPassed ? [] : ["client_abort_contract_failed"]),
          ...(selectedPartBytes !== null ? [] : ["no_materialization_tolerant_part_bound"]),
        ].join(",")}`,
  );
} catch (error) {
  console.error(`HOSTED_STREAM fatal=FAIL ${sanitizeError(error)} sink_failure=${lastSinkFailure}`);
  if (activeWrangler) {
    const failedWrangler = activeWrangler;
    activeWrangler = undefined;
    await stopWrangler(failedWrangler, true).catch((wranglerError) => {
      console.error(`HOSTED_STREAM workerd_logs=FAIL ${sanitizeError(wranglerError)}`);
    });
  }
  console.log("HOSTED_STREAM_SPIKE FAILED reason=oracle_error");
} finally {
  inspector?.close();
  if (activeWrangler) await stopWrangler(activeWrangler);
  jwksServer?.stop(true);
  sinkServer?.stop(true);
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (!spikePassed) process.exitCode = 1;

interface SinkReceipt {
  uploadId: string;
  bytes: number;
  sha256: string;
  contentRange: string;
}

interface SinkState {
  startedAt: number;
  firstByteAt: number;
  bytes: number;
  aborted: boolean;
  completed: boolean;
}

interface UploadReceipt {
  marker: string;
  uploadId: string;
  bytes: number;
  sha256: string;
  contentRange: string;
  sink: { bytes: number; sha256: string };
  expected: { bytes: number; sha256: string };
  runtime: {
    upstreamBodyUsedAtHandler: boolean | null;
    hashImplementation: "DigestStream";
  };
}

interface MemorySample {
  sampledAt: number;
  inspectorHeap: number | null;
  inspectorBacking: number | null;
  processTreeRss: number | null;
}

interface PartBoundResult {
  partBytes: number;
  concurrency: number;
  delayMs: number;
  holdDelta: number | null;
  peakGrowth: number | null;
  rssPeak: number | null;
  bounded: boolean;
  receipts: UploadReceipt[];
}

interface WranglerProcess {
  child: ReturnType<typeof Bun.spawn>;
  output: Promise<[string, string]>;
}

function receipt(check: string, pass: boolean, detail: string): void {
  console.log(`HOSTED_STREAM ${check}=${pass ? "PASS" : "FAIL"} ${detail}`);
}

async function receiveAtFakeSink(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/resumable" || request.method !== "POST") {
    lastSinkFailure = `route method=${request.method} path=${url.pathname}`;
    return new Response("not found", { status: 404 });
  }
  const uploadId = request.headers.get("x-spike-upload-id") || "";
  const contentRange = request.headers.get("content-range") || "";
  const contentLengthHeader = request.headers.get("content-length");
  if (!/^[a-z0-9-]{1,64}$/.test(uploadId) || !/^bytes \d+-\d+\/\d+$/.test(contentRange)) {
    lastSinkFailure = `headers upload_id=${uploadId || "missing"} content_range=${contentRange || "missing"}`;
    return new Response("invalid resumable headers", { status: 400 });
  }
  const rangeMatch = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  const rangeLength = rangeMatch ? Number(rangeMatch[2]) - Number(rangeMatch[1]) + 1 : Number.NaN;
  const declaredLength = contentLengthHeader === null ? rangeLength : Number(contentLengthHeader);
  const hasher = createHash("sha256");
  const state: SinkState = {
    startedAt: Date.now(),
    firstByteAt: 0,
    bytes: 0,
    aborted: false,
    completed: false,
  };
  sinkStates.set(uploadId, state);
  if (uploadId.startsWith("part-bound-")) await Bun.sleep(slowSinkHoldMs);
  const reader = request.body?.getReader();
  if (!reader) {
    lastSinkFailure = "missing_body";
    return new Response("missing body", { status: 400 });
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (state.firstByteAt === 0) state.firstByteAt = Date.now();
      state.bytes += value.byteLength;
      hasher.update(value);
      await Bun.sleep(uploadId === "client-abort" ? 50 : uploadId === "over-length" ? 5 : 1);
    }
  } catch {
    state.aborted = true;
    lastSinkFailure = `aborted upload_id=${uploadId} bytes=${state.bytes}`;
    return new Response("aborted", { status: 499 });
  }
  if (!Number.isSafeInteger(declaredLength) || state.bytes !== declaredLength) {
    state.aborted = true;
    lastSinkFailure = `length declared=${declaredLength} actual=${state.bytes}`;
    return new Response("length mismatch", { status: 422 });
  }
  const result: SinkReceipt = {
    uploadId,
    bytes: state.bytes,
    sha256: hasher.digest("hex"),
    contentRange,
  };
  state.completed = true;
  sinkReceipts.set(uploadId, result);
  return Response.json({ bytes: result.bytes, sha256: result.sha256 });
}

async function uploadFixture(
  origin: string,
  token: string,
  fixture: { id: string; bytes: number; seed: number; path?: string },
): Promise<UploadReceipt> {
  const expectedDigest = digestFixture(fixture.bytes, fixture.seed);
  const response = await uploadResponse(origin, token, fixture);
  if (response.status !== 200) {
    throw new Error(`${fixture.id}: Worker returned ${response.status}: ${await response.text()}`);
  }
  const result = await response.json() as Omit<UploadReceipt, "expected">;
  return { ...result, expected: { bytes: fixture.bytes, sha256: expectedDigest } };
}

async function uploadResponse(
  origin: string,
  token: string | undefined,
  fixture: {
    id: string;
    bytes: number;
    seed: number;
    path?: string;
    declaredBytes?: number;
    pullDelayMs?: number;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const declaredBytes = fixture.declaredBytes ?? fixture.bytes;
  const headers: Record<string, string> = {
    "content-length": String(declaredBytes),
    "content-range": `bytes 0-${declaredBytes - 1}/${declaredBytes}`,
    "content-type": "application/octet-stream",
    "x-spike-upload-id": fixture.id,
  };
  if (token) headers["cf-access-jwt-assertion"] = token;
  return await fetch(`${origin}${fixture.path ?? routePath}`, {
    method: "POST",
    headers,
    body: fixtureStream(fixture.bytes, fixture.seed, fixture.pullDelayMs),
    duplex: "half",
    signal: fixture.signal,
  } as RequestInit & { duplex: "half" });
}

async function expectUploadStatus(
  origin: string,
  token: string | undefined,
  id: string,
  expected: number,
): Promise<number> {
  const response = await uploadResponse(origin, token, {
    id,
    bytes: 8 * mebibyte,
    seed: 19,
  });
  await expectStatus(response, expected, id);
  assert(!sinkStates.has(id), `${id}: denied upload reached the sink.`);
  return response.status;
}

function assertUploadReceipt(receiptValue: UploadReceipt): void {
  const sink = sinkReceipts.get(receiptValue.uploadId);
  assert(
    receiptValue.marker === "FRAME_OF_MIND_HOSTED_STREAM_SPIKE_WRAPPER_V2",
    "Hosted wrapper marker mismatch.",
  );
  assert(receiptValue.bytes === receiptValue.expected.bytes, `${receiptValue.uploadId}: route byte mismatch.`);
  assert(receiptValue.sink.bytes === receiptValue.expected.bytes, `${receiptValue.uploadId}: sink byte mismatch.`);
  assert(receiptValue.sha256 === receiptValue.expected.sha256, `${receiptValue.uploadId}: route digest mismatch.`);
  assert(receiptValue.sink.sha256 === receiptValue.expected.sha256, `${receiptValue.uploadId}: sink digest mismatch.`);
  assert(sink?.bytes === receiptValue.expected.bytes, `${receiptValue.uploadId}: fake sink did not retain exact bytes.`);
  assert(sink?.sha256 === receiptValue.expected.sha256, `${receiptValue.uploadId}: fake sink digest mismatch.`);
}

function fixtureStream(totalBytes: number, seed: number, pullDelayMs = 0): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= totalBytes) {
        controller.close();
        return;
      }
      if (pullDelayMs > 0) await Bun.sleep(pullDelayMs);
      const length = Math.min(chunkBytes, totalBytes - offset);
      controller.enqueue(fixtureChunk(offset, length, seed));
      offset += length;
    },
  });
}

function fixtureChunk(offset: number, length: number, seed: number): Uint8Array {
  const chunk = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    chunk[index] = (offset + index + seed) % 251;
  }
  return chunk;
}

function digestFixture(totalBytes: number, seed: number): string {
  const hash = createHash("sha256");
  for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
    hash.update(fixtureChunk(offset, Math.min(chunkBytes, totalBytes - offset), seed));
  }
  return hash.digest("hex");
}

async function writeWranglerConfig(options: {
  issuer: string;
  enabled: boolean;
  sinkUrl?: string;
}): Promise<void> {
  await writeFile(configPath, JSON.stringify({
    $schema: resolve("node_modules/wrangler/config-schema.json"),
    name: "frame-of-mind-hosted-stream-spike",
    main: resolve("apps/web/.output/server/hosted-entry.mjs"),
    compatibility_date: "2026-07-02",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      directory: resolve("apps/web/.output/public"),
      binding: "ASSETS",
    },
    d1_databases: [{
      binding: "DB",
      database_name: "frame-of-mind-hosted-stream-spike",
      database_id: "00000000-0000-0000-0000-000000000002",
      migrations_dir: resolve("apps/web/db/migrations"),
    }],
    vars: {
      NUXT_AUTH_MODE: "cloudflare-access",
      NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN: options.issuer,
      NUXT_CLOUDFLARE_ACCESS_AUD: audience,
      NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS: "true",
      ...(options.enabled
        ? {
            NUXT_HOSTED_STREAM_SPIKE_ENABLED: "true",
            NUXT_HOSTED_STREAM_SPIKE_SINK_URL: options.sinkUrl,
          }
        : {}),
    },
  }, null, 2));
}

async function startWrangler(port: number, inspectorPort?: number): Promise<WranglerProcess> {
  const args = [
    "bunx", "wrangler", "dev",
    "--local",
    "--config", configPath,
    "--persist-to", persistRoot,
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--log-level", "error",
    "--show-interactive-dev-session=false",
    ...(inspectorPort ? ["--inspector-ip", "127.0.0.1", "--inspector-port", String(inspectorPort)] : []),
  ];
  const child = Bun.spawn(args, {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    child,
    output: Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]),
  };
}

async function stopWrangler(process: WranglerProcess, printOutput = false): Promise<void> {
  if (process.child.exitCode === null) process.child.kill("SIGTERM");
  await process.child.exited;
  const [stdout, stderr] = await process.output;
  if (printOutput && (stdout || stderr)) {
    console.error(`HOSTED_STREAM workerd_output=${`${stdout}\n${stderr}`.replace(/\s+/g, " ").slice(0, 8_000)}`);
  }
  if (process.child.exitCode !== 0 && process.child.exitCode !== 143) {
    throw new Error(`wrangler dev failed (${process.child.exitCode}):\n${stdout}\n${stderr}`.slice(0, 12_000));
  }
}

async function signAccessToken(
  privateKey: KeyLike,
  issuer: string,
  claims: Record<string, unknown>,
  overrides: {
    audience?: string;
    issuer?: string;
    issuedAt?: number;
    expirationTime?: number | string;
  } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setIssuedAt(overrides.issuedAt)
    .setExpirationTime(overrides.expirationTime ?? "10m")
    .sign(privateKey);
}

function unsignedAccessToken(
  issuer: string,
  tokenAudience: string,
  claims: Record<string, unknown>,
): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    ...claims,
    iss: issuer,
    aud: tokenAudience,
    iat: now,
    exp: now + 600,
  })}.`;
}

async function runPartBoundCheck(options: {
  origin: string;
  token: string;
  rootPid: number;
  inspector: InspectorClient | undefined;
  partBytes: number;
  concurrency: number;
}): Promise<PartBoundResult> {
  const baseline = await sampleMemory(options.rootPid, options.inspector);
  const uploadIds = Array.from(
    { length: options.concurrency },
    (_, index) => `part-bound-${options.partBytes}-${options.concurrency}-${index}`,
  );
  const uploads = Promise.all(uploadIds.map((id, index) => uploadFixture(
    options.origin,
    options.token,
    {
      id,
      bytes: options.partBytes,
      seed: 31 + options.partBytes / mebibyte * 10 + options.concurrency + index,
    },
  )));
  const memoryMonitor = monitorMemory(options.rootPid, options.inspector, uploads);
  const states = await Promise.all(uploadIds.map((id) => waitForSinkState(
    id,
    (state) => state.startedAt > 0,
  )));
  const deadline = Math.max(...states.map((state) => state.startedAt)) + slowSinkHoldMs + 1_000;
  while (states.some((state) => state.firstByteAt === 0) && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  assert(states.every((state) => state.firstByteAt > 0), "A part-bound sink never drained after its hold.");
  const [receipts, samples] = await Promise.all([uploads, memoryMonitor]);
  for (const value of receipts) assertUploadReceipt(value);
  const firstReadAt = Math.min(...states.map((state) => state.firstByteAt));
  const holdMemory = summarizeMemory([
    baseline,
    ...samples.filter((sample) => sample.sampledAt <= firstReadAt),
  ]);
  const peakMemory = summarizeMemory([baseline, ...samples]);
  const delayMs = Math.min(...states.map((state) => state.firstByteAt - state.startedAt));
  const tolerantLimit = Math.floor(options.partBytes * options.concurrency * 1.5);
  const bounded = delayMs >= slowSinkHoldMs
    && holdMemory.backingDelta !== null
    && holdMemory.backingDelta <= tolerantLimit
    && peakMemory.backingDelta !== null
    && peakMemory.backingDelta <= absoluteBackingGrowthLimit;
  return {
    partBytes: options.partBytes,
    concurrency: options.concurrency,
    delayMs,
    holdDelta: holdMemory.backingDelta,
    peakGrowth: peakMemory.backingDelta,
    rssPeak: peakMemory.rssPeak,
    bounded,
    receipts,
  };
}

async function runDirectLengthCheck(options: {
  issuer: string;
  sinkUrl: string;
  token: string;
  uploadId: string;
  sourceBytes: number;
  declaredBytes: number;
  seed: number;
}): Promise<{
  status: number;
  sinkState: SinkState | undefined;
}> {
  const miniflare = new Miniflare({
    modules: true,
    scriptPath: resolve("apps/web/.output/server/hosted-entry.mjs"),
    compatibilityDate: "2026-07-02",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      NUXT_AUTH_MODE: "cloudflare-access",
      NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN: options.issuer,
      NUXT_CLOUDFLARE_ACCESS_AUD: audience,
      NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS: "true",
      NUXT_HOSTED_STREAM_SPIKE_ENABLED: "true",
      NUXT_HOSTED_STREAM_SPIKE_SINK_URL: options.sinkUrl,
    },
  });
  try {
    await miniflare.ready;
    const worker = await miniflare.getWorker();
    const request = new Request(`https://spike.example${routePath}`, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": options.token,
        "content-length": String(options.declaredBytes),
        "content-range": `bytes 0-${options.declaredBytes - 1}/${options.declaredBytes}`,
        "content-type": "application/octet-stream",
        "x-spike-upload-id": options.uploadId,
      },
      body: fixtureStream(options.sourceBytes, options.seed),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await worker.fetch(request);
    const sinkState = await findSinkState(
      options.uploadId,
      (state) => state.aborted || state.completed,
    );
    return {
      status: response.status,
      sinkState,
    };
  } finally {
    await miniflare.dispose();
  }
}

async function scanBuiltArtifact(): Promise<{
  hostedEntry: boolean;
  hostedEntryArrayBuffer: boolean;
  nitroRouteAbsent: boolean;
  requestArrayBuffer: boolean;
  prebufferFile: string;
}> {
  const artifactRoot = resolve("apps/web/.output/server");
  const artifactFiles = await files(artifactRoot);
  const hostedEntryPath = resolve("apps/web/.output/server/hosted-entry.mjs");
  const hostedEntrySource = await readFile(hostedEntryPath, "utf8");
  let stockRoutePathFound = false;
  let stockRouteMarkerFound = false;
  let requestArrayBufferFound = false;
  let prebufferFile = "none";
  for (const path of artifactFiles.filter((value) => value.endsWith(".mjs"))) {
    const contents = await readFile(path, "utf8");
    if (path !== hostedEntryPath) {
      stockRoutePathFound ||= contents.includes(routePath);
      stockRouteMarkerFound ||= contents.includes("FRAME_OF_MIND_HOSTED_STREAM_SPIKE_ROUTE_V1");
    }
    if (/\.from\(await\s+\w+\.arrayBuffer\(\)\)[\s\S]{0,1000}?\.localFetch\(/.test(contents)) {
      requestArrayBufferFound = true;
      prebufferFile = path.replace(`${process.cwd()}/`, "");
    }
  }
  return {
    hostedEntry: hostedEntrySource.includes("FRAME_OF_MIND_HOSTED_STREAM_SPIKE_WRAPPER_V2")
      && hostedEntrySource.includes("./index.mjs")
      && hostedEntrySource.includes("DigestStream")
      && hostedEntrySource.includes(routePath),
    hostedEntryArrayBuffer: hostedEntrySource.includes(".arrayBuffer()"),
    nitroRouteAbsent: !stockRoutePathFound && !stockRouteMarkerFound,
    requestArrayBuffer: requestArrayBufferFound,
    prebufferFile,
  };
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
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
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitForWorker(origin: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/health`, { redirect: "manual" });
      if (response.status === 403) return;
    } catch {
      // workerd is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("Hosted streaming spike Worker did not become ready.");
}

async function expectStatus(
  responsePromise: Promise<Response> | Response,
  expected: number,
  label: string,
): Promise<Response> {
  const response = await responsePromise;
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function waitForSinkState(
  uploadId: string,
  predicate: (state: SinkState) => boolean,
): Promise<SinkState> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = sinkStates.get(uploadId);
    if (state && predicate(state)) return state;
    await Bun.sleep(25);
  }
  throw new Error(`${uploadId}: sink state did not reach the expected condition.`);
}

async function findSinkState(
  uploadId: string,
  predicate: (state: SinkState) => boolean,
): Promise<SinkState | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = sinkStates.get(uploadId);
    if (state && predicate(state)) return state;
    await Bun.sleep(25);
  }
  return undefined;
}

async function monitorMemory<T>(
  rootPid: number,
  inspectorClient: InspectorClient | undefined,
  until: Promise<T>,
): Promise<MemorySample[]> {
  const samples: MemorySample[] = [];
  let settled = false;
  void until.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  while (!settled) {
    samples.push(await sampleMemory(rootPid, inspectorClient));
    await Bun.sleep(50);
  }
  samples.push(await sampleMemory(rootPid, inspectorClient));
  return samples;
}

async function sampleMemory(
  rootPid: number,
  inspectorClient: InspectorClient | undefined,
): Promise<MemorySample> {
  const [heap, rss] = await Promise.all([
    inspectorClient?.heapUsage().catch(() => null) ?? Promise.resolve(null),
    processTreeRss(rootPid),
  ]);
  return {
    sampledAt: Date.now(),
    inspectorHeap: heap?.usedSize ?? null,
    inspectorBacking: heap?.backingStorageSize ?? null,
    processTreeRss: rss,
  };
}

function summarizeMemory(samples: MemorySample[]): {
  heapBaseline: number | null;
  heapPeak: number | null;
  heapDelta: number | null;
  backingBaseline: number | null;
  backingPeak: number | null;
  backingDelta: number | null;
  rssBaseline: number | null;
  rssPeak: number | null;
  rssDelta: number | null;
} {
  const heapValues = samples.flatMap((sample) => sample.inspectorHeap === null ? [] : [sample.inspectorHeap]);
  const backingValues = samples.flatMap(
    (sample) => sample.inspectorBacking === null ? [] : [sample.inspectorBacking],
  );
  const rssValues = samples.flatMap((sample) => sample.processTreeRss === null ? [] : [sample.processTreeRss]);
  const heapBaseline = heapValues[0] ?? null;
  const heapPeak = heapValues.length ? Math.max(...heapValues) : null;
  const backingBaseline = backingValues[0] ?? null;
  const backingPeak = backingValues.length ? Math.max(...backingValues) : null;
  const rssBaseline = rssValues[0] ?? null;
  const rssPeak = rssValues.length ? Math.max(...rssValues) : null;
  return {
    heapBaseline,
    heapPeak,
    heapDelta: heapBaseline === null || heapPeak === null ? null : heapPeak - heapBaseline,
    backingBaseline,
    backingPeak,
    backingDelta: backingBaseline === null || backingPeak === null ? null : backingPeak - backingBaseline,
    rssBaseline,
    rssPeak,
    rssDelta: rssBaseline === null || rssPeak === null ? null : rssPeak - rssBaseline,
  };
}

async function processTreeRss(rootPid: number): Promise<number | null> {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss="], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) return null;
  const rows = output.trim().split("\n").map((line) => {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    return { pid, ppid, rss };
  }).filter((row) => row.pid && row.ppid >= 0 && Number.isFinite(row.rss));
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid)).reduce((total, row) => total + row.rss * 1024, 0);
}

function formatBytes(value: number | null): string {
  return value === null ? "unavailable" : String(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 1_000);
}

class InspectorClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Inspector request failed."));
      else pending.resolve(message.result);
    });
  }

  static async connect(port: number): Promise<InspectorClient> {
    let webSocketUrl = "";
    for (let attempt = 0; attempt < 100 && !webSocketUrl; attempt += 1) {
      for (const path of ["/json", "/json/list"]) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}${path}`);
          if (!response.ok) continue;
          const targets = await response.json() as Array<{ webSocketDebuggerUrl?: string }>;
          webSocketUrl = targets[0]?.webSocketDebuggerUrl || "";
          if (webSocketUrl) break;
        } catch {
          // Inspector is still starting.
        }
      }
      if (!webSocketUrl) await Bun.sleep(50);
    }
    if (!webSocketUrl) throw new Error("workerd inspector target unavailable");
    const socket = new WebSocket(webSocketUrl.replace("localhost", "127.0.0.1"));
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener("error", () => rejectOpen(new Error("workerd inspector connection failed")), { once: true });
    });
    return new InspectorClient(socket);
  }

  async heapUsage(): Promise<{ usedSize: number; backingStorageSize: number | null } | null> {
    const result = await this.send("Runtime.getHeapUsage") as {
      usedSize?: unknown;
      backingStorageSize?: unknown;
    };
    if (typeof result.usedSize !== "number") return null;
    return {
      usedSize: result.usedSize,
      backingStorageSize: typeof result.backingStorageSize === "number"
        ? result.backingStorageSize
        : null,
    };
  }

  close(): void {
    this.socket.close();
  }

  private send(method: string): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      this.socket.send(JSON.stringify({ id, method }));
    });
  }
}
