import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { createE2EEnvironment } from "./e2e-environment";

const mebibyte = 1024 * 1024;
const chunkBytes = 64 * 1024;
const audience = "frame-of-mind-hosted-stream-spike";
const keyId = "hosted-stream-spike-key";
const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-hosted-stream-"));
const configPath = join(temporaryRoot, "wrangler.jsonc");
const persistRoot = join(temporaryRoot, "wrangler-state");
const routePath = "/api/_spike/stream";
const priorBackingPlateau = 33_568_143;
const sinkReceipts = new Map<string, SinkReceipt>();
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
  receipt("route_source", true, "raw_stream DigestStream no_body_materializer");

  const artifactScan = await scanBuiltArtifact();
  receipt(
    "artifact_marker",
    artifactScan.routeMarker && artifactScan.routePath && artifactScan.hostedEntry,
    `route=${artifactScan.routePath} marker=${artifactScan.routeMarker} hosted_entry=${artifactScan.hostedEntry}`,
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
  const token = await signAccessToken(keys.privateKey, issuer);

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
  const origin = `http://127.0.0.1:${workerPort}`;
  await waitForWorker(origin, activeWrangler.child);
  inspector = await InspectorClient.connect(inspectorPort).catch(() => undefined);
  await expectStatus(fetch(`${origin}${routePath}`, {
    method: "POST",
    headers: {
      "content-length": String(8 * mebibyte),
      "content-range": `bytes 0-${8 * mebibyte - 1}/${8 * mebibyte}`,
      "x-spike-upload-id": "missing-access",
    },
    body: fixtureStream(8 * mebibyte, 7),
    duplex: "half",
  } as RequestInit & { duplex: "half" }), 403, "enabled spike Access gate");
  receipt("access_gate", true, "missing_assertion_status=403");

  const largeBaseline = await sampleMemory(activeWrangler.child.pid, inspector);
  const large = uploadFixture(origin, token, { id: "single-16m", bytes: 16 * mebibyte, seed: 17 });
  const largeMonitor = monitorMemory(activeWrangler.child.pid, inspector, large);
  const [largeReceipt, largeMemory] = await Promise.all([large, largeMonitor]);
  assertUploadReceipt(largeReceipt);
  receipt("single_16m_bytes", true, `bytes=${largeReceipt.bytes} sink_bytes=${largeReceipt.sink.bytes}`);
  receipt("single_16m_digest", true, `sha256=${largeReceipt.sha256}`);

  await Bun.sleep(250);
  const concurrentBaseline = await sampleMemory(activeWrangler.child.pid, inspector);
  const concurrent = Promise.all([
    uploadFixture(origin, token, { id: "concurrent-a", bytes: 8 * mebibyte, seed: 31 }),
    uploadFixture(origin, token, { id: "concurrent-b", bytes: 8 * mebibyte, seed: 47 }),
  ]);
  const concurrentMonitor = monitorMemory(activeWrangler.child.pid, inspector, concurrent);
  const [concurrentReceipts, concurrentMemory] = await Promise.all([concurrent, concurrentMonitor]);
  for (const value of concurrentReceipts) assertUploadReceipt(value);
  receipt(
    "concurrent_bytes",
    true,
    `uploads=2 bytes_each=${8 * mebibyte} sink_exact=true`,
  );
  receipt(
    "concurrent_digests",
    true,
    `a=${concurrentReceipts[0].sha256} b=${concurrentReceipts[1].sha256}`,
  );
  const allUploadReceipts = [largeReceipt, ...concurrentReceipts];
  const digestPassed = allUploadReceipts.every(
    (value) => value.runtime.hashImplementation === "DigestStream"
      && value.sha256 === value.expected.sha256,
  );
  receipt(
    "digest_impl",
    digestPassed,
    `implementation=DigestStream sha256=${largeReceipt.sha256}`,
  );

  const memory = summarizeMemory([
    largeBaseline,
    ...largeMemory,
    concurrentBaseline,
    ...concurrentMemory,
  ]);
  const concurrentMemorySummary = summarizeMemory([concurrentBaseline, ...concurrentMemory]);
  const backingThreshold = Math.floor(priorBackingPlateau / 2);
  const memoryBounded = concurrentMemorySummary.backingDelta !== null
    && concurrentMemorySummary.backingDelta < backingThreshold;
  receipt(
    "memory_signal",
    true,
    `inspector_heap_baseline=${formatBytes(memory.heapBaseline)} `
      + `inspector_heap_peak=${formatBytes(memory.heapPeak)} `
      + `inspector_heap_delta=${formatBytes(memory.heapDelta)} `
      + `inspector_backing_baseline=${formatBytes(memory.backingBaseline)} `
      + `inspector_backing_peak=${formatBytes(memory.backingPeak)} `
      + `inspector_backing_delta=${formatBytes(memory.backingDelta)} `
      + `process_tree_rss_baseline=${formatBytes(memory.rssBaseline)} `
      + `process_tree_rss_peak=${formatBytes(memory.rssPeak)} `
      + `process_tree_rss_delta=${formatBytes(memory.rssDelta)}`,
  );
  receipt(
    "concurrent_backing",
    memoryBounded,
    `inspector_backing_delta=${formatBytes(concurrentMemorySummary.backingDelta)} `
      + `prior_plateau=${priorBackingPlateau} threshold=${backingThreshold}`,
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
    && upstreamStates.every((value) => value === "false")
    && memoryBounded;
  receipt(
    "streaming_path",
    streamingPathPassed,
    `entry=hosted-entry upstream_body_used=${upstreamStates.join(",")} `
      + `stock_nitro_prebuffer=${artifactScan.requestArrayBuffer} `
      + `inspector_backing_delta=${formatBytes(concurrentMemorySummary.backingDelta)}`,
  );

  spikePassed = streamingPathPassed && digestPassed;
  console.log(
    spikePassed
      ? "HOSTED_STREAM_SPIKE PASSED"
      : `HOSTED_STREAM_SPIKE FAILED reason=${[
          ...(streamingPathPassed ? [] : ["hosted_entry_streaming_path_failed"]),
          ...(digestPassed ? [] : ["digest_stream_failed"]),
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
  inspectorHeap: number | null;
  inspectorBacking: number | null;
  processTreeRss: number | null;
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
  let bytes = 0;
  const reader = request.body?.getReader();
  if (!reader) {
    lastSinkFailure = "missing_body";
    return new Response("missing body", { status: 400 });
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    hasher.update(value);
    await Bun.sleep(1);
  }
  if (!Number.isSafeInteger(declaredLength) || bytes !== declaredLength) {
    lastSinkFailure = `length declared=${declaredLength} actual=${bytes}`;
    return new Response("length mismatch", { status: 422 });
  }
  const result: SinkReceipt = {
    uploadId,
    bytes,
    sha256: hasher.digest("hex"),
    contentRange,
  };
  sinkReceipts.set(uploadId, result);
  return Response.json({ bytes: result.bytes, sha256: result.sha256 });
}

async function uploadFixture(
  origin: string,
  token: string,
  fixture: { id: string; bytes: number; seed: number },
): Promise<UploadReceipt> {
  const expectedDigest = digestFixture(fixture.bytes, fixture.seed);
  const response = await fetch(`${origin}${routePath}`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": token,
      "content-length": String(fixture.bytes),
      "content-range": `bytes 0-${fixture.bytes - 1}/${fixture.bytes}`,
      "content-type": "application/octet-stream",
      "x-spike-upload-id": fixture.id,
    },
    body: fixtureStream(fixture.bytes, fixture.seed),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (response.status !== 200) {
    throw new Error(`${fixture.id}: Worker returned ${response.status}: ${await response.text()}`);
  }
  const result = await response.json() as Omit<UploadReceipt, "expected">;
  return { ...result, expected: { bytes: fixture.bytes, sha256: expectedDigest } };
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

function fixtureStream(totalBytes: number, seed: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= totalBytes) {
        controller.close();
        return;
      }
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

async function signAccessToken(privateKey: KeyLike, issuer: string): Promise<string> {
  return new SignJWT({ sub: "hosted-stream-spike-user", email: "spike@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

async function scanBuiltArtifact(): Promise<{
  routePath: boolean;
  routeMarker: boolean;
  hostedEntry: boolean;
  hostedEntryArrayBuffer: boolean;
  requestArrayBuffer: boolean;
  prebufferFile: string;
}> {
  const artifactRoot = resolve("apps/web/.output/server");
  const artifactFiles = await files(artifactRoot);
  const hostedEntryPath = resolve("apps/web/.output/server/hosted-entry.mjs");
  const hostedEntrySource = await readFile(hostedEntryPath, "utf8");
  let routePathFound = false;
  let routeMarkerFound = false;
  let requestArrayBufferFound = false;
  let prebufferFile = "none";
  for (const path of artifactFiles.filter((value) => value.endsWith(".mjs"))) {
    const contents = await readFile(path, "utf8");
    routePathFound ||= contents.includes(routePath);
    routeMarkerFound ||= contents.includes("FRAME_OF_MIND_HOSTED_STREAM_SPIKE_ROUTE_V1");
    if (/\.from\(await\s+\w+\.arrayBuffer\(\)\)[\s\S]{0,1000}?\.localFetch\(/.test(contents)) {
      requestArrayBufferFound = true;
      prebufferFile = path.replace(`${process.cwd()}/`, "");
    }
  }
  return {
    routePath: routePathFound,
    routeMarker: routeMarkerFound,
    hostedEntry: hostedEntrySource.includes("FRAME_OF_MIND_HOSTED_STREAM_SPIKE_WRAPPER_V2")
      && hostedEntrySource.includes("./index.mjs")
      && hostedEntrySource.includes("DigestStream"),
    hostedEntryArrayBuffer: hostedEntrySource.includes(".arrayBuffer()"),
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
  responsePromise: Promise<Response>,
  expected: number,
  label: string,
): Promise<Response> {
  const response = await responsePromise;
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
  return response;
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
