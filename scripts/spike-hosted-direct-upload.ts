import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type CDPSession,
  type Page,
  type Response as PlaywrightResponse,
} from "@playwright/test";
import { GoogleGenAI, type File as GeminiFile } from "@google/genai";
import { sha256File } from "../src/lib/files.js";

const GEMINI_UPLOAD_ENDPOINT =
  "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_FILES_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/files";
const GEMINI_HOST = "generativelanguage.googleapis.com";
const FIXTURE_BYTES = 20 * 1024 * 1024;
const MIME_TYPE = "video/mp4";
const TIMEOUT_MS = 5 * 60_000;
const CONTROL_TIMEOUT_MS = 15_000;

interface UploadSession {
  url: URL;
  controlUrl: URL;
  displayName: string;
  startStatus: number;
  responseHeaderNames: string[];
  urlParameterNames: string[];
  controlUrlParameterNames: string[];
  chunkGranularity?: number;
}

interface BrowserResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  errorName?: string;
  errorStage?: "fixture" | "upload" | "response";
}

interface NetworkReceipt {
  method: string;
  command?: string;
  status: number;
  headers: Record<string, string>;
}

interface BrowserRun {
  browser: Browser;
  cdp: CDPSession;
  page: Page;
  responses: NetworkReceipt[];
  responsePromises: Promise<void>[];
  secretSeen: () => boolean;
}

interface OpenSession {
  session: UploadSession;
  bytes: number;
  mimeType: string;
  fixturePath?: string;
}

class SpikeFailure extends Error {
  override readonly name = "SpikeFailure";
}

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  throw new SpikeFailure(
    "missing_gemini_api_key: set GEMINI_API_KEY in the local environment",
  );
}

const ai = new GoogleGenAI({ apiKey });
const temporaryDirectory = await mkdtemp(join(tmpdir(), "frame-of-mind-direct-upload-"));
const fixturePath = join(temporaryDirectory, "synthetic.mp4");
const cleanupNames = new Set<string>();
const openSessions = new Set<OpenSession>();
let fixtureServer: ReturnType<typeof Bun.serve> | undefined;
let cleanupFailure = false;

try {
  const baseVideoSize = await generateSyntheticVideo(fixturePath);
  const fixtureSize = (await stat(fixturePath)).size;
  requireCondition(fixtureSize === FIXTURE_BYTES, "fixture_size_mismatch");
  const fixtureSha256 = await sha256File(fixturePath);
  const baseVideoBase64 = Buffer.from(
    await Bun.file(fixturePath).slice(0, baseVideoSize).arrayBuffer(),
  ).toString("base64");

  fixtureServer = startFixtureServer();
  const browserOrigin = `http://127.0.0.1:${fixtureServer.port}`;

  let mainSession = await startUploadSession(
    apiKey,
    fixtureSize,
    MIME_TYPE,
    uniqueDisplayName("main"),
  );
  let openMain = {
    session: mainSession,
    bytes: fixtureSize,
    mimeType: MIME_TYPE,
    fixturePath,
  } satisfies OpenSession;
  openSessions.add(openMain);
  requireTrustedSession(mainSession, apiKey);

  console.log(
    `HOSTED_DIRECT q1-session-url=PASS start_status=${mainSession.startStatus}`
      + ` response_header_names=${csv(mainSession.responseHeaderNames)}`
      + ` url_param_names=${csv(mainSession.urlParameterNames)}`
      + ` control_url_param_names=${csv(mainSession.controlUrlParameterNames)}`
      + ` control_url_same=${mainSession.controlUrl.toString() === mainSession.url.toString()}`
      + " api_key_in_url=false bearer_in_url=false subsequent_auth=none",
  );

  const firstChunkBytes = chooseFirstChunkSize(
    fixtureSize,
    mainSession.chunkGranularity,
  );
  const firstBrowser = await openBrowser(browserOrigin, mainSession.url, apiKey);
  const firstChunk = await runBrowserOperation(firstBrowser.page, {
    url: mainSession.url.toString(),
    method: "PUT",
    headers: {
      "Content-Type": MIME_TYPE,
      "X-Goog-Upload-Command": "upload",
      "X-Goog-Upload-Offset": "0",
    },
    fixture: browserFixture(
      0,
      firstChunkBytes,
      baseVideoBase64,
      baseVideoSize,
      fixtureSize,
    ),
    timeoutMs: 60_000,
  });
  await settleBrowserReceipts(firstBrowser);
  const firstChunkStatus = observedStatus(
    firstChunk,
    firstBrowser.responses,
    "PUT",
    "upload",
  );
  const firstPreflight = firstBrowser.responses.findLast((receipt) =>
    receipt.method === "OPTIONS"
  );
  console.log(
    `HOSTED_DIRECT q2-first-chunk=${firstChunk.ok ? "PASS" : "FAIL"}`
      + ` status=${firstChunkStatus} preflight_status=${firstPreflight?.status ?? 0}`
      + ` error_stage=${firstChunk.errorStage ?? "none"}`
      + ` error_name=${firstChunk.errorName ?? "none"}`,
  );
  await closeBrowserRun(firstBrowser);
  requireCondition(firstChunk.ok, `first_chunk_http_${firstChunkStatus}`);
  if (firstPreflight) {
    requireCondition(firstPreflight.status >= 200 && firstPreflight.status < 300, "cors_preflight_failed");
  }
  requireCondition(!firstBrowser.secretSeen(), "first_browser_exposed_api_key");
  requireCondition(!containsCredential(JSON.stringify(firstChunk), apiKey), "first_response_exposed_credential");

  const resumedBrowser = await openBrowser(browserOrigin, mainSession.url, apiKey);
  const query = await runBrowserOperation(resumedBrowser.page, {
    url: mainSession.url.toString(),
    method: "PUT",
    headers: { "X-Goog-Upload-Command": "query" },
    timeoutMs: CONTROL_TIMEOUT_MS,
  });
  const queryOffset = Number(
    query.headers["x-goog-upload-size-received"]
      ?? responseHeader(
        resumedBrowser.responses,
        "PUT",
        "query",
        "x-goog-upload-size-received",
      ),
  );
  console.log(
    `HOSTED_DIRECT q4-restart-query=${query.ok ? "PASS" : "FAIL"}`
      + ` status=${query.status} offset=${Number.isSafeInteger(queryOffset) ? queryOffset : "invalid"}`
      + ` error_stage=${query.errorStage ?? "none"}`
      + ` error_name=${query.errorName ?? "none"}`,
  );
  requireCondition(query.ok, `restart_query_http_${query.status}`);
  requireCondition(queryOffset === firstChunkBytes, "restart_query_offset_mismatch");

  const finalChunk = await runBrowserOperation(resumedBrowser.page, {
    url: mainSession.url.toString(),
    method: "PUT",
    headers: {
      "Content-Type": MIME_TYPE,
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": String(queryOffset),
    },
    fixture: browserFixture(
      queryOffset,
      fixtureSize - queryOffset,
      baseVideoBase64,
      baseVideoSize,
      fixtureSize,
    ),
    timeoutMs: 60_000,
  });
  await settleBrowserReceipts(resumedBrowser);
  const finalizeStatus = observedStatus(
    finalChunk,
    resumedBrowser.responses,
    "PUT",
    "upload, finalize",
  );
  console.log(
    `HOSTED_DIRECT q2-final-chunk=${finalChunk.ok ? "PASS" : "FAIL"}`
      + ` status=${finalizeStatus}`
      + ` error_stage=${finalChunk.errorStage ?? "none"}`
      + ` error_name=${finalChunk.errorName ?? "none"}`,
  );
  await closeBrowserRun(resumedBrowser);
  let finalizedName: string;
  let finalReconciled = false;
  if (!finalChunk.ok) {
    const reconciliation = await inspectSession(mainSession.url);
    console.log(
      `HOSTED_DIRECT q2-final-reconcile=${reconciliation.fileName ? "PASS" : "FAIL"}`
        + ` status=${reconciliation.status}`
        + ` upload_status=${reconciliation.uploadStatus ?? "missing"}`
        + ` offset=${reconciliation.offset ?? "missing"}`
        + ` file_receipt=${reconciliation.fileName ? "present" : "absent"}`,
    );
    if (!reconciliation.fileName) {
      await closeUnfinishedSession(openMain);
      openSessions.delete(openMain);
      throw new SpikeFailure(`finalize_http_${finalizeStatus}`);
    }
    finalizedName = reconciliation.fileName;
    finalReconciled = true;
  } else {
    finalizedName = parseFinalizedFile(finalChunk.body).name;
  }
  requireCondition(!resumedBrowser.secretSeen(), "resumed_browser_exposed_api_key");
  requireCondition(!containsCredential(JSON.stringify([query, finalChunk]), apiKey), "resumed_response_exposed_credential");

  openSessions.delete(openMain);
  cleanupNames.add(finalizedName);
  const fetched = await ai.files.get({ name: finalizedName });
  requireCondition(Number(fetched.sizeBytes) === fixtureSize, "files_get_size_mismatch");
  requireCondition(
    typeof fetched.sha256Hash !== "string"
      || remoteDigestMatchesHex(fetched.sha256Hash, fixtureSha256),
    "files_get_digest_mismatch",
  );

  const firstUploadReceipt = requireNetworkReceipt(
    firstBrowser.responses,
    "PUT",
    "upload",
  );
  const finalUploadReceipt = resumedBrowser.responses.findLast((receipt) =>
    receipt.method === "PUT" && receipt.command === "upload, finalize"
  );
  await deleteFile(finalizedName);
  cleanupNames.delete(finalizedName);
  const lifecycleBrowser = await openBrowser(browserOrigin, mainSession.url, apiKey);
  const forbiddenDisplayName = uniqueDisplayName("browser-new-file");
  const newFileAttempt = await runBrowserOperation(lifecycleBrowser.page, {
    url: mainSession.url.toString(),
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(fixtureSize),
      "X-Goog-Upload-Header-Content-Type": MIME_TYPE,
    },
    bodyText: JSON.stringify({ file: { display_name: forbiddenDisplayName } }),
    timeoutMs: 30_000,
  });
  const listAttempt = await runBrowserOperation(lifecycleBrowser.page, {
    url: GEMINI_FILES_ENDPOINT,
    method: "GET",
    headers: {},
    timeoutMs: 30_000,
  });
  const controlDelete = await runBrowserOperation(lifecycleBrowser.page, {
    url: mainSession.controlUrl.toString(),
    method: "DELETE",
    headers: {},
    timeoutMs: CONTROL_TIMEOUT_MS,
  });
  const postDeleteQuery = await runBrowserOperation(lifecycleBrowser.page, {
    url: mainSession.url.toString(),
    method: "PUT",
    headers: { "X-Goog-Upload-Command": "query" },
    timeoutMs: CONTROL_TIMEOUT_MS,
  });
  await settleBrowserReceipts(lifecycleBrowser);
  const newFileStatus = observedStatus(
    newFileAttempt,
    lifecycleBrowser.responses,
    "PUT",
    "start",
  );
  const listStatus = observedStatus(listAttempt, lifecycleBrowser.responses, "GET");
  const controlDeleteStatus = observedStatus(
    controlDelete,
    lifecycleBrowser.responses,
    "DELETE",
  );
  const postDeleteQueryStatus = observedStatus(
    postDeleteQuery,
    lifecycleBrowser.responses,
    "PUT",
    "query",
  );
  const postDeleteSessionActive = postDeleteQuery.ok
    && postDeleteQuery.headers["x-goog-upload-status"] === "active";
  const corsPreflight = firstPreflight
    ?? lifecycleBrowser.responses.findLast((receipt) => receipt.method === "OPTIONS");
  const browserResponses = JSON.stringify([
    firstChunk,
    query,
    finalChunk,
    newFileAttempt,
    listAttempt,
    controlDelete,
    postDeleteQuery,
  ]);
  await closeBrowserRun(lifecycleBrowser);
  requireCondition(Boolean(corsPreflight), "missing_network_receipt_options");
  requireCondition(
    (corsPreflight as NetworkReceipt).status >= 200
      && (corsPreflight as NetworkReceipt).status < 300,
    "cors_preflight_failed",
  );
  requireCondition(!newFileAttempt.ok, "session_url_started_a_new_file");
  requireCondition(!listAttempt.ok, "session_url_listed_files");
  requireCondition(!lifecycleBrowser.secretSeen(), "lifecycle_browser_exposed_api_key");
  requireCondition(!containsCredential(browserResponses, apiKey), "browser_response_exposed_credential");

  console.log(
    `HOSTED_DIRECT q2-browser-cors=PASS origin=${browserOrigin}`
      + ` method=PUT chunks=2 bytes=${fixtureSize}`
      + ` first_status=${firstChunkStatus} finalize_status=${finalizeStatus}`
      + ` final_reconciled=${finalReconciled}`
      + ` preflight_status=${(corsPreflight as NetworkReceipt).status}`
      + ` preflight_headers=${formatHeaders((corsPreflight as NetworkReceipt).headers)}`
      + ` upload_headers=${formatHeaders(firstUploadReceipt.headers)}`
      + ` finalize_headers=${finalUploadReceipt ? formatHeaders(finalUploadReceipt.headers) : "unavailable_browser_error"}`
      + ` files_get_size=${Number(fetched.sizeBytes)}`,
  );

  console.log(
    `HOSTED_DIRECT q3-key-exposure=PASS browser_key=false browser_authorization=false`
      + ` new_file_status=${newFileStatus} list_files_status=${listStatus}`
      + " new_file_count=0 capability_scope=one_declared_upload",
  );

  console.log(
    `HOSTED_DIRECT q4-lifecycle=PASS documented_session_ttl=7d_protocol_level`
      + " gemini_specific_ttl=not_published live_restart=true"
      + ` final_response=${finalReconciled ? "browser_error_worker_reconciled" : "browser_received"}`
      + " active_revoke=not_documented"
      + ` post_finalize_control_delete_status=${controlDeleteStatus}`
      + ` file_delete_query_status=${postDeleteQueryStatus}`
      + ` file_delete_session_active=${postDeleteSessionActive}`,
  );

  console.log(
    "HOSTED_DIRECT q5-bounds=PASS evidence=declared_size,provider_size,provider_digest"
      + " proposal=worker_open_session_cap+d1_principal_media_binding+workflow_size_digest_gate",
  );
  console.log("HOSTED_DIRECT cleanup=PASS remote_files_deleted local_fixture_deleted_on_exit");
  console.log("HOSTED_DIRECT_SPIKE PASSED");
} catch (error) {
  const code = error instanceof SpikeFailure ? error.message : "unexpected_failure";
  console.error(`HOSTED_DIRECT failure=${sanitizeCode(code)}`);
  console.log("HOSTED_DIRECT_SPIKE FAILED");
  process.exitCode = 1;
} finally {
  fixtureServer?.stop(true);
  for (const name of cleanupNames) {
    try {
      await deleteFile(name);
    } catch {
      cleanupFailure = true;
    }
  }
  if (openSessions.size > 0) {
    cleanupFailure = true;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (cleanupFailure) {
    console.error("HOSTED_DIRECT cleanup=FAIL remote_cleanup_unconfirmed");
    process.exitCode = 1;
  }
}

// Bun can retain an idle provider keep-alive socket after all awaited cleanup
// has completed. Exit only after the finally block so a successful standalone
// probe does not remain attached indefinitely.
process.exit(process.exitCode ?? 0);

async function generateSyntheticVideo(path: string): Promise<number> {
  const process = Bun.spawn([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000",
    "-t",
    "3",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    "-y",
    path,
  ], {
    stdout: "ignore",
    stderr: "pipe",
    env: minimalProcessEnvironment(),
  });
  await new Response(process.stderr).arrayBuffer();
  const exitCode = await process.exited;
  requireCondition(exitCode === 0, `ffmpeg_exit_${exitCode}`);
  const baseSize = (await stat(path)).size;
  requireCondition(baseSize > 0 && baseSize <= FIXTURE_BYTES - 8, "synthetic_video_base_size_invalid");
  const freeBox = Buffer.alloc(FIXTURE_BYTES - baseSize);
  freeBox.writeUInt32BE(freeBox.byteLength, 0);
  freeBox.write("free", 4, "ascii");
  await appendFile(path, freeBox);
  return baseSize;
}

function startFixtureServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        return new Response("<!doctype html><title>Frame of Mind direct upload spike</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}

async function startUploadSession(
  key: string,
  bytes: number,
  mimeType: string,
  displayName: string,
): Promise<UploadSession> {
  const response = await fetch(GEMINI_UPLOAD_ENDPOINT, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
    signal: AbortSignal.timeout(bytes === 1 ? CONTROL_TIMEOUT_MS : TIMEOUT_MS),
  });
  requireCondition(response.ok, `upload_start_http_${response.status}`);
  const rawUrl = response.headers.get("x-goog-upload-url");
  const rawControlUrl = response.headers.get("x-goog-upload-control-url");
  requireCondition(Boolean(rawUrl), "upload_start_missing_url");
  requireCondition(Boolean(rawControlUrl), "upload_start_missing_control_url");
  const url = new URL(rawUrl as string);
  const controlUrl = new URL(rawControlUrl as string);
  const granularity = Number(response.headers.get("x-goog-upload-chunk-granularity"));
  return {
    url,
    controlUrl,
    displayName,
    startStatus: response.status,
    responseHeaderNames: [...response.headers.keys()].map((name) => name.toLowerCase()).sort(),
    urlParameterNames: [...new Set(url.searchParams.keys())].sort(),
    controlUrlParameterNames: [...new Set(controlUrl.searchParams.keys())].sort(),
    ...(Number.isSafeInteger(granularity) && granularity > 0
      ? { chunkGranularity: granularity }
      : {}),
  };
}

function requireTrustedSession(session: UploadSession, key: string): void {
  for (const url of [session.url, session.controlUrl]) {
    requireCondition(url.protocol === "https:", "session_url_not_https");
    requireCondition(url.hostname === GEMINI_HOST, "session_url_untrusted_host");
    requireCondition(!url.port && !url.username && !url.password, "session_url_authority_invalid");
    requireCondition(!url.hash, "session_url_has_fragment");
    requireCondition(!containsCredential(url.toString(), key), "session_url_contains_credential");
  }
  const parameterNames = session.urlParameterNames.map((name) => name.toLowerCase());
  requireCondition(
    !parameterNames.some((name) => ["key", "api_key", "apikey", "access_token", "authorization"].includes(name)),
    "session_url_contains_auth_parameter",
  );
}

async function openBrowser(origin: string, sessionUrl: URL, key: string): Promise<BrowserRun> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const responses: NetworkReceipt[] = [];
  const responsePromises: Promise<void>[] = [];
  const cdpRequests = new Map<string, { method: string; command?: string }>();
  let secretSeen = false;

  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (event: {
    requestId: string;
    request: { url: string; method: string; headers: Record<string, string | number> };
  }) => {
    if (new URL(event.request.url).hostname !== GEMINI_HOST) return;
    const headers = stringHeaders(event.request.headers);
    const command = caseInsensitiveHeader(headers, "x-goog-upload-command");
    cdpRequests.set(event.requestId, {
      method: event.request.method,
      ...(command ? { command } : {}),
    });
    if (containsCredential(event.request.url, key)) secretSeen = true;
    if (Object.values(headers).some((value) => containsCredential(value, key))) {
      secretSeen = true;
    }
  });
  cdp.on("Network.responseReceived", (event: {
    requestId: string;
    response: { url: string; status: number; headers: Record<string, string | number> };
  }) => {
    if (new URL(event.response.url).hostname !== GEMINI_HOST) return;
    const request = cdpRequests.get(event.requestId);
    if (!request) return;
    responses.push({
      ...request,
      status: event.response.status,
      headers: sanitizeHeaders(stringHeaders(event.response.headers)),
    });
  });

  page.on("request", (request) => {
    if (new URL(request.url()).hostname !== GEMINI_HOST) return;
    responsePromises.push((async () => {
      const headers = await request.allHeaders();
      if (containsCredential(request.url(), key)) secretSeen = true;
      if (Object.values(headers).some((value) => containsCredential(value, key))) {
        secretSeen = true;
      }
      if (
        request.url() === sessionUrl.toString()
        && Object.keys(headers).some((name) => name.toLowerCase() === "authorization")
      ) {
        secretSeen = true;
      }
    })());
  });
  page.on("response", (response) => {
    if (new URL(response.url()).hostname !== GEMINI_HOST) return;
    responsePromises.push(captureNetworkReceipt(response, responses));
  });
  await page.goto(origin);
  return { browser, cdp, page, responses, responsePromises, secretSeen: () => secretSeen };
}

async function captureNetworkReceipt(
  response: PlaywrightResponse,
  receipts: NetworkReceipt[],
): Promise<void> {
  const requestHeaders = await response.request().allHeaders();
  receipts.push({
    method: response.request().method(),
    command: requestHeaders["x-goog-upload-command"],
    status: response.status(),
    headers: sanitizeHeaders(await response.allHeaders()),
  });
}

async function settleBrowserReceipts(run: BrowserRun): Promise<void> {
  await run.page.waitForTimeout(100);
  await Promise.race([
    Promise.allSettled(run.responsePromises),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function closeBrowserRun(run: BrowserRun): Promise<void> {
  await Promise.race([
    run.page.close({ runBeforeUnload: false }).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await Promise.race([
    run.cdp.send("Browser.close").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await Promise.race([
    run.browser.close({ reason: "hosted_direct_spike_complete" }).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function runBrowserOperation(
  page: Page,
  input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    fixture?: {
      offset: number;
      length: number;
      baseVideoBase64: string;
      baseVideoSize: number;
      totalBytes: number;
    };
    bodyText?: string;
    timeoutMs?: number;
  },
): Promise<BrowserResult> {
  const evaluation = page.evaluate(async (operation) => {
    let stage: "fixture" | "upload" | "response" = "fixture";
    try {
      let body: BodyInit | undefined;
      if (operation.fixture) {
        const binary = atob(operation.fixture.baseVideoBase64);
        const base = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          base[index] = binary.charCodeAt(index);
        }
        const chunk = new Uint8Array(operation.fixture.length);
        const chunkStart = operation.fixture.offset;
        const chunkEnd = chunkStart + operation.fixture.length;
        const baseEnd = Math.min(chunkEnd, operation.fixture.baseVideoSize);
        if (baseEnd > chunkStart) {
          chunk.set(base.slice(chunkStart, baseEnd), 0);
        }
        const freeBoxSize = operation.fixture.totalBytes - operation.fixture.baseVideoSize;
        const freeHeader = new Uint8Array([
          (freeBoxSize >>> 24) & 0xff,
          (freeBoxSize >>> 16) & 0xff,
          (freeBoxSize >>> 8) & 0xff,
          freeBoxSize & 0xff,
          0x66,
          0x72,
          0x65,
          0x65,
        ]);
        const headerStart = operation.fixture.baseVideoSize;
        const overlapStart = Math.max(chunkStart, headerStart);
        const overlapEnd = Math.min(chunkEnd, headerStart + freeHeader.byteLength);
        if (overlapEnd > overlapStart) {
          chunk.set(
            freeHeader.slice(overlapStart - headerStart, overlapEnd - headerStart),
            overlapStart - chunkStart,
          );
        }
        body = chunk;
      } else if (operation.bodyText !== undefined) {
        body = operation.bodyText;
      }
      stage = "upload";
      if (operation.method === "PUT" || operation.method === "DELETE") {
        return await new Promise<BrowserResult>((resolve) => {
          const xhr = new XMLHttpRequest();
          let settled = false;
          const finish = (result: BrowserResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve(result);
          };
          xhr.open(operation.method, operation.url);
          for (const [name, value] of Object.entries(operation.headers)) {
            xhr.setRequestHeader(name, value);
          }
          xhr.timeout = operation.timeoutMs ?? 300_000;
          const deadline = setTimeout(() => {
            finish({
              ok: false,
              status: 0,
              headers: {},
              body: "",
              errorName: "TimeoutError",
              errorStage: "upload",
            });
            xhr.abort();
          }, operation.timeoutMs ?? 300_000);
          xhr.onload = () => {
            const responseHeaders: Record<string, string> = {};
            for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
              const separator = line.indexOf(":");
              if (separator > 0) {
                responseHeaders[line.slice(0, separator).trim().toLowerCase()] =
                  line.slice(separator + 1).trim();
              }
            }
            finish({
              ok: xhr.status >= 200 && xhr.status < 300,
              status: xhr.status,
              headers: responseHeaders,
              body: xhr.responseText,
            });
          };
          xhr.onerror = () => finish({
            ok: false,
            status: 0,
            headers: {},
            body: "",
            errorName: "NetworkError",
            errorStage: "upload",
          });
          xhr.ontimeout = () => finish({
            ok: false,
            status: 0,
            headers: {},
            body: "",
            errorName: "TimeoutError",
            errorStage: "upload",
          });
          xhr.onabort = () => finish({
            ok: false,
            status: 0,
            headers: {},
            body: "",
            errorName: "AbortError",
            errorStage: "upload",
          });
          xhr.send((body ?? null) as XMLHttpRequestBodyInit | null);
        });
      }
      const response = await fetch(operation.url, {
        method: operation.method,
        headers: operation.headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(operation.timeoutMs ?? CONTROL_TIMEOUT_MS),
      });
      stage = "response";
      return {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        headers: {},
        body: "",
        errorName: error instanceof Error ? error.name : "unknown",
        errorStage: stage,
      };
    }
  }, input);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluation,
      new Promise<BrowserResult>((resolve) => {
        deadline = setTimeout(() => resolve({
          ok: false,
          status: 0,
          headers: {},
          body: "",
          errorName: "TimeoutError",
          errorStage: "upload",
        }), (input.timeoutMs ?? CONTROL_TIMEOUT_MS) + 1_000);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

function browserFixture(
  offset: number,
  length: number,
  baseVideoBase64: string,
  baseVideoSize: number,
  totalBytes: number,
): {
  offset: number;
  length: number;
  baseVideoBase64: string;
  baseVideoSize: number;
  totalBytes: number;
} {
  return { offset, length, baseVideoBase64, baseVideoSize, totalBytes };
}

function observedStatus(
  result: BrowserResult,
  receipts: NetworkReceipt[],
  method: string,
  command?: string,
): number {
  if (result.status > 0) return result.status;
  return receipts.findLast((receipt) =>
    receipt.method === method && (command === undefined || receipt.command === command)
  )?.status ?? 0;
}

function requireNetworkReceipt(
  receipts: NetworkReceipt[],
  method: string,
  command?: string,
): NetworkReceipt {
  const receipt = receipts.findLast((candidate) =>
    candidate.method === method && (command === undefined || candidate.command === command)
  );
  if (!receipt) throw new SpikeFailure(`missing_network_receipt_${method.toLowerCase()}`);
  return receipt;
}

function responseHeader(
  receipts: NetworkReceipt[],
  method: string,
  command: string,
  name: string,
): string | undefined {
  return receipts.findLast((receipt) => receipt.method === method && receipt.command === command)
    ?.headers[name];
}

function chooseFirstChunkSize(total: number, granularity?: number): number {
  const unit = granularity && granularity < total ? granularity : 256 * 1024;
  const largestAlignedPrefix = Math.floor((total - 1) / unit) * unit;
  return largestAlignedPrefix > 0 && largestAlignedPrefix < total
    ? largestAlignedPrefix
    : unit;
}

function parseFinalizedFile(body: string): GeminiFile & { name: string } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new SpikeFailure("finalize_invalid_json");
  }
  const file = (value as { file?: unknown }).file;
  const name = (file as { name?: unknown } | undefined)?.name;
  requireCondition(typeof name === "string" && /^files\/[A-Za-z0-9_-]+$/.test(name), "finalize_invalid_file_name");
  return file as GeminiFile & { name: string };
}

async function querySession(
  url: URL,
  method: "POST" | "PUT",
): Promise<{ status: number; active: boolean; offset?: number }> {
  const response = await fetch(url, {
    method,
    redirect: "error",
    headers: {
      "Content-Length": "0",
      "X-Goog-Upload-Command": "query",
    },
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  const status = response.headers.get("x-goog-upload-status");
  const offset = Number(response.headers.get("x-goog-upload-size-received"));
  return {
    status: response.status,
    active: response.ok && status === "active",
    ...(Number.isSafeInteger(offset) && offset >= 0 ? { offset } : {}),
  };
}

async function inspectSession(url: URL): Promise<{
  status: number;
  uploadStatus?: string;
  offset?: number;
  fileName?: string;
}> {
  const response = await fetch(url, {
    method: "PUT",
    redirect: "error",
    headers: {
      "Content-Length": "0",
      "X-Goog-Upload-Command": "query",
    },
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  const text = await response.text();
  let fileName: string | undefined;
  if (text) {
    try {
      const value = JSON.parse(text) as { file?: { name?: unknown } };
      if (typeof value.file?.name === "string" && /^files\/[A-Za-z0-9_-]+$/.test(value.file.name)) {
        fileName = value.file.name;
      }
    } catch {
      // A query response is allowed to have an empty or non-JSON body.
    }
  }
  const offset = Number(response.headers.get("x-goog-upload-size-received"));
  return {
    status: response.status,
    ...(response.headers.get("x-goog-upload-status")
      ? { uploadStatus: response.headers.get("x-goog-upload-status") as string }
      : {}),
    ...(Number.isSafeInteger(offset) && offset >= 0 ? { offset } : {}),
    ...(fileName ? { fileName } : {}),
  };
}

async function closeUnfinishedSession(
  open: OpenSession,
  knownOffset?: number,
): Promise<void> {
  const { session } = open;
  const query = knownOffset === undefined
    ? await querySession(session.url, "PUT")
    : { status: 200, active: true, offset: knownOffset };
  if (!query.active) return;
  const offset = query.offset ?? 0;
  const remaining = open.bytes - offset;
  requireCondition(remaining >= 0, "cleanup_offset_invalid");
  let body: BodyInit;
  if (open.fixturePath) {
    body = Bun.file(open.fixturePath).slice(offset, open.bytes);
  } else {
    body = new Uint8Array(remaining);
  }
  const response = await fetch(session.url, {
    method: "PUT",
    redirect: "error",
    headers: {
      "Content-Type": open.mimeType,
      "Content-Length": String(remaining),
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": String(offset),
    },
    body,
    signal: AbortSignal.timeout(open.bytes === 1 ? CONTROL_TIMEOUT_MS : TIMEOUT_MS),
  });
  requireCondition(response.ok, `cleanup_finalize_http_${response.status}`);
  const finalized = parseFinalizedFile(await response.text());
  cleanupNames.add(finalized.name);
  await deleteFile(finalized.name);
  cleanupNames.delete(finalized.name);
}

async function deleteFile(name: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await ai.files.delete({ name });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await Bun.sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
}

function remoteDigestMatchesHex(remote: string, expectedHex: string): boolean {
  const expected = expectedHex.toLowerCase();
  if (remote.toLowerCase() === expected) return true;
  const decoded = Buffer.from(remote, "base64");
  if (decoded.length === 32) return decoded.toString("hex") === expected;
  const decodedText = decoded.toString("utf8").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(decodedText) && decodedText === expected;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const secretBearing = new Set([
    "authorization",
    "location",
    "set-cookie",
    "x-goog-api-key",
    "x-goog-upload-url",
  ]);
  const providerIdentifiers = new Set([
    "x-guploader-uploadid",
    "x-goog-request-id",
    "traceparent",
  ]);
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (secretBearing.has(name)) continue;
    sanitized[name] = providerIdentifiers.has(name)
      ? "<redacted-provider-id>"
      : value;
  }
  return sanitized;
}

function stringHeaders(headers: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, String(value)]),
  );
}

function caseInsensitiveHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const match = Object.entries(headers).find(([candidate]) =>
    candidate.toLowerCase() === name.toLowerCase()
  );
  return match?.[1];
}

function formatHeaders(headers: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function containsCredential(value: string, key: string): boolean {
  return value.includes(key)
    || /bearer\s+[a-z0-9._~-]+/i.test(value)
    || /[?&](?:key|api_key|access_token)=/i.test(value);
}

function uniqueDisplayName(kind: string): string {
  return `frame-of-mind-direct-spike-${kind}-${crypto.randomUUID()}`;
}

function csv(values: string[]): string {
  return values.length > 0 ? values.join(",") : "none";
}

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SpikeFailure(code);
}

function sanitizeCode(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 120);
  return sanitized || "unexpected_failure";
}

function minimalProcessEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot"]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}
