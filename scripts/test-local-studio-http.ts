import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DEFAULT_GEMINI_MODEL } from "../src/adapters/gemini-model";
import {
  verifyImmutableJobInput,
  type AnalysisJob,
} from "../src/domain/studio-schemas";
import { validateMediaSessionTransition } from "../src/domain/studio-state";
import { LocalSqliteJobRepository } from "../apps/web/server-local/studio-jobs/sqlite-job-repository";
import { publishedRunDirectory } from "../apps/web/server-local/studio-jobs/run-reimport";
import { LocalMediaStagingAdapter } from "../apps/web/server-local/studio-media/local-media-staging";
import { videoRunFixture } from "../apps/web/test/fixtures";
import { createE2EIsolation } from "../apps/web/e2e/support/isolation";
import { resolvePrebuiltWebOutput } from "./prebuilt-artifact";

const bootstrapToken = "studio-http-test-bootstrap-capability-0123456789";
const isolation = await createE2EIsolation("local-studio-http");
const port = await isolation.reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const webRoot = join(process.cwd(), "apps", "web");
const prebuiltOutput = await resolvePrebuiltWebOutput("node-server");
const webOutput = prebuiltOutput ?? join(webRoot, ".output");
const mediaRoot = join(isolation.root, "media");
const spikeRoot = join(isolation.root, "frame-of-mind-studio-spike-http-fixture");
await Promise.all([mkdir(mediaRoot, { recursive: true }), mkdir(spikeRoot, { recursive: true })]);
const outputRoot = join(mediaRoot, "runs");
const databasePath = join(mediaRoot, "studio.sqlite");
const environment = {
  ...process.env,
  FRAME_OF_MIND_STUDIO: "1",
  FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN: bootstrapToken,
  FRAME_OF_MIND_STUDIO_SPIKE: "1",
  FRAME_OF_MIND_STUDIO_SPIKE_DIR: spikeRoot,
  FRAME_OF_MIND_CHECKOUT_ROOT: process.cwd(),
  FRAME_OF_MIND_MEDIA_ROOT: mediaRoot,
  FRAME_OF_MIND_CONTEXT_ROOT: join(mediaRoot, "context"),
  HOST: "127.0.0.1",
  NITRO_HOST: "127.0.0.1",
  PORT: String(port),
  NITRO_PORT: String(port),
  NUXT_SQLITE_PATH: databasePath,
  FRAME_OF_MIND_OUTPUT: outputRoot,
  FRAME_OF_MIND_MAINTENANCE_INTERVAL_MS: "0",
  XDG_CONFIG_HOME: join(mediaRoot, "config"),
};
delete environment.NITRO_UNIX_SOCKET;
// CI has no provider credentials, and this contract must not depend on a maintainer's .env.
for (const key of [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GRANOLA_API_KEY",
  "BLUEDOT_MCP_URL",
  "GRANOLA_MCP_URL",
] as const) {
  delete environment[key];
}

async function expectStatus(
  response: Response,
  expected: number,
  label: string,
): Promise<Response> {
  if (response.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, received ${response.status}: `
      + await response.text(),
    );
  }
  return response;
}

function createStudioProbe(origin: string) {
  let cookie = "";
  const jsonHeaders = () => ({
    "content-type": "application/json",
    origin,
    ...(cookie ? { cookie } : {}),
  });

  return {
    async bootstrap(token: string, headers: Record<string, string> = {}) {
      const response = await fetch(`${origin}/__studio/bootstrap`, {
        method: "POST",
        headers: { ...jsonHeaders(), ...headers },
        body: JSON.stringify({ token }),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";", 1)[0] || "";
      return response;
    },
    get(path: string, headers: Record<string, string> = {}) {
      return fetch(`${origin}${path}`, {
        headers: { ...(cookie ? { cookie } : {}), ...headers },
        redirect: "manual",
      });
    },
    head(path: string, headers: Record<string, string> = {}) {
      return fetch(`${origin}${path}`, {
        method: "HEAD",
        headers: { ...(cookie ? { cookie } : {}), ...headers },
        redirect: "manual",
      });
    },
    mutate(
      path: string,
      method: "POST" | "PUT" | "DELETE",
      body: unknown,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${origin}${path}`, {
        method,
        headers: { ...jsonHeaders(), ...headers },
        body: JSON.stringify(body),
      });
    },
    upload(
      path: string,
      bytes: Uint8Array,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${origin}${path}`, {
        method: "PUT",
        headers: {
          "content-type": "video/mp4",
          "content-length": String(bytes.byteLength),
          origin,
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: bytes,
      });
    },
    uploadContext(
      bytes: Uint8Array,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${origin}/api/context-files`, {
        method: "POST",
        headers: {
          "content-type": "text/vtt",
          "content-length": String(bytes.byteLength),
          "x-context-format": "vtt",
          origin,
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: bytes,
      });
    },
  };
}

console.log("Building the local Studio HTTP contract fixture...");
if (prebuiltOutput) {
  console.log("LOCAL_STUDIO_HTTP build=SKIP prebuilt=node-server");
} else {
  const build = Bun.spawn(["bun", "run", "--cwd", "apps/web", "build"], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await build.exited !== 0) {
    throw new Error("Local Studio contract fixture build failed.");
  }
}

const runFixture = await videoRunFixture();
const retainedFixture = new Uint8Array(64);
retainedFixture.set([0x00, 0x00, 0x00, 0x18], 0);
retainedFixture.set(new TextEncoder().encode("ftypisom"), 4);
for (let index = 12; index < retainedFixture.length; index += 1) {
  retainedFixture[index] = index % 251;
}
const retainedDigest = createHash("sha256").update(retainedFixture).digest("hex");
runFixture.manifest.recordingSha256 = retainedDigest;

async function* mediaChunks(bytes: Uint8Array) {
  yield bytes;
}

async function stageFixtureMedia(input: {
  id: string;
  idempotencyKey: string;
  mode: "retained" | "ephemeral";
  now?: Date;
}) {
  const adapter = new LocalMediaStagingAdapter({
    rootDirectory: mediaRoot,
    checkoutRoot: process.cwd(),
    partSizeBytes: retainedFixture.byteLength,
    minimumFreeBytes: 0,
    createId: () => input.id,
    ...(input.now ? { now: () => input.now! } : {}),
  });
  const session = await adapter.create({
    idempotencyKey: input.idempotencyKey,
    expectedBytes: retainedFixture.byteLength,
    mimeType: "video/mp4",
    retention: input.mode === "retained"
      ? { mode: "retained", ttlSeconds: 60 * 60 }
      : { mode: "ephemeral" },
  });
  await adapter.writePart(session.id, {
    part: 0,
    offset: 0,
    contentLength: retainedFixture.byteLength,
    bytes: mediaChunks(retainedFixture),
  });
  await adapter.seal(session.id, { expectedSha256: retainedDigest });
  await adapter.transition(validateMediaSessionTransition({
    id: session.id,
    expected: "sealed",
    next: "in_use",
  }));
  const retained = input.mode === "retained"
    ? await adapter.transition(validateMediaSessionTransition({
        id: session.id,
        expected: "in_use",
        next: "retained",
      }))
    : await adapter.deleteEphemeralExecutionLease(session.id, retainedDigest);
  return retained;
}

const retainedMedia = await stageFixtureMedia({
  id: "media_http_review_0001",
  idempotencyKey: "studio-http-review-media-0001",
  mode: "retained",
});
const expiredMedia = await stageFixtureMedia({
  id: "media_http_expired_0001",
  idempotencyKey: "studio-http-expired-media-0001",
  mode: "retained",
  now: new Date("2020-01-01T00:00:00.000Z"),
});
const cleanedMedia = await stageFixtureMedia({
  id: "media_http_cleaned_0001",
  idempotencyKey: "studio-http-cleaned-media-0001",
  mode: "ephemeral",
});
const seedDatabase = new Database(databasePath);
let seededSucceededJobId: string;
let seededRunJob: AnalysisJob | undefined;
try {
  const seededJobIds = [
    "job_http_reimport_0001",
    "job_http_expired_0001",
    "job_http_cleaned_0001",
  ];
  const repository = new LocalSqliteJobRepository(seedDatabase, {
    createId: () => seededJobIds.shift()!,
  });
  const baseTime = Date.now() + 2_000;
  const fixtures = [
    {
      idempotencyKey: "studio-http-reimport-job-0001",
      media: retainedMedia,
      runId: runFixture.manifest.runId,
      projectionWarning: "Synthetic import warning.",
    },
    {
      idempotencyKey: "studio-http-expired-job-0001",
      media: expiredMedia,
      runId: "run_http_expired_media_0001",
      createdAt: "2020-01-01T00:10:00.000Z",
    },
    {
      idempotencyKey: "studio-http-cleaned-job-0001",
      media: cleanedMedia,
      runId: "run_http_cleaned_media_0001",
    },
  ];
  let succeeded;
  for (const [index, fixture] of fixtures.entries()) {
    const fixtureTime = fixture.createdAt
      ? Date.parse(fixture.createdAt)
      : baseTime + index * 10;
    const createdAt = new Date(fixtureTime).toISOString();
    const seeded = await repository.createOrReplay({
      idempotencyKey: fixture.idempotencyKey,
      verifiedInput: await verifyImmutableJobInput({
        mediaSessionId: fixture.media.id,
        mediaSha256: retainedDigest,
        context: { mode: "none" },
        recipe: {
          id: runFixture.manifest.recipe.id,
          custom: runFixture.manifest.recipe.custom,
          revision: runFixture.manifest.recipe.revision,
          sha256: runFixture.manifest.recipe.sha256,
        },
        model: runFixture.manifest.model,
        retention: fixture.media.retention,
      }),
      createdAt,
    });
    await repository.transition({
      jobId: seeded.job.id,
      expectedStage: "queued",
      nextStage: "fetching_context",
      occurredAt: new Date(fixtureTime + 1).toISOString(),
      message: "Synthetic HTTP fixture claimed.",
    });
    await repository.transition({
      jobId: seeded.job.id,
      expectedStage: "fetching_context",
      nextStage: "cleaning_up",
      occurredAt: new Date(fixtureTime + 2).toISOString(),
      message: "Synthetic HTTP fixture published.",
    });
    succeeded = await repository.transition({
      jobId: seeded.job.id,
      expectedStage: "cleaning_up",
      nextStage: "succeeded",
      occurredAt: new Date(fixtureTime + 3).toISOString(),
      message: "Synthetic HTTP fixture completed.",
      runId: fixture.runId,
      ...(fixture.projectionWarning
        ? { projectionWarning: fixture.projectionWarning }
        : {}),
    });
    if (index === 0) {
      seededSucceededJobId = succeeded.id;
      seededRunJob = succeeded;
    }
  }
  if (!seededRunJob) throw new Error("Synthetic HTTP run job was not created.");
  const runDirectory = publishedRunDirectory(seededRunJob, outputRoot);
  await mkdir(runDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(runDirectory, "analysis.json"),
      JSON.stringify(runFixture.analysis),
    ),
    writeFile(
      join(runDirectory, "manifest.json"),
      JSON.stringify(runFixture.manifest),
    ),
  ]);
} finally {
  seedDatabase.close();
}

const server = Bun.spawn([
  "bun",
  "--preload",
  join(webOutput, "server/sentry.server.config.mjs"),
  join(webOutput, "server/index.mjs"),
], {
  cwd: webRoot,
  env: environment,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/studio/session`);
      if (response.status === 401) {
        ready = true;
        break;
      }
    } catch {
      // Listener is not ready.
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Local Studio contract server did not become ready.");

  const probe = createStudioProbe(baseUrl);
  await expectStatus(
    await probe.get("/"),
    401,
    "Studio Home requires a session",
  );
  const launchPage = await expectStatus(
    await probe.get("/__studio/launch"),
    200,
    "inert launch page remains available for fragment exchange",
  );
  if (!(await launchPage.text()).includes("Opening private Studio")) {
    throw new Error("Local Studio launch page did not render its inert exchange state.");
  }
  await expectStatus(
    await probe.get("/connections?probe=1"),
    401,
    "query-bearing Connections page requires a session",
  );
  await expectStatus(
    await probe.get("/connections/"),
    401,
    "trailing-slash Connections page requires a session",
  );
  await expectStatus(
    await probe.get("/context"),
    401,
    "Context page requires a session",
  );
  await expectStatus(
    await probe.get("/intent"),
    401,
    "Intent page requires a session",
  );
  await expectStatus(
    await probe.get("/run"),
    401,
    "Run receipt page requires a session",
  );
  await expectStatus(
    await probe.get("/activity"),
    401,
    "Activity page requires a session",
  );
  await expectStatus(
    await probe.get("/activity/job_01K123456789ABC"),
    401,
    "Activity detail page requires a session",
  );
  await expectStatus(
    await probe.get(`/review/${encodeURIComponent(runFixture.manifest.runId)}`),
    401,
    "review workspace requires a session",
  );
  await expectStatus(
    await probe.get(`/api/runs/${encodeURIComponent(runFixture.manifest.runId)}/media`, {
      range: "bytes=0-3",
    }),
    401,
    "retained media requires a session",
  );
  await expectStatus(
    await probe.get(`/api/runs/${encodeURIComponent(runFixture.manifest.runId)}/media-status`),
    401,
    "retained media status requires a session",
  );
  await expectStatus(
    await probe.mutate(
      `/api/runs/${encodeURIComponent(runFixture.manifest.runId)}/media/reattach`,
      "POST",
      { mediaSessionId: "media_01K123456789ABC" },
    ),
    401,
    "review media reattachment requires a session",
  );
  await expectStatus(
    await probe.get("/api/studio/recipes"),
    401,
    "recipe catalog requires a Studio session",
  );
  await expectStatus(
    await probe.get("/api/studio/session", { host: "attacker.example" }),
    403,
    "hostile Host fails closed",
  );
  await expectStatus(
    await probe.get("/api/studio/jobs"),
    401,
    "job list requires a Studio session",
  );
  await expectStatus(
    await probe.get("/api/studio/jobs/job_01K123456789ABC"),
    401,
    "job detail requires a Studio session",
  );
  await expectStatus(
    await probe.get("/api/studio/jobs/job_01K123456789ABC/support-receipt"),
    401,
    "support receipt requires a Studio session",
  );
  await expectStatus(
    await probe.get("/api/studio/maintenance"),
    401,
    "maintenance diagnostics require a Studio session",
  );
  await expectStatus(
    await probe.mutate(
      "/api/studio/jobs/job_01K123456789ABC/reimport",
      "POST",
      {},
    ),
    401,
    "job re-import requires a Studio session",
  );
  await expectStatus(
    await probe.mutate(
      "/api/studio/media/media_01K123456789ABC/cleanup-retry",
      "POST",
      {},
    ),
    401,
    "media cleanup retry requires a Studio session",
  );
  await expectStatus(
    await probe.mutate("/api/studio/composer/jobs", "POST", {}),
    401,
    "composer job creation requires a Studio session",
  );
  await expectStatus(
    await probe.uploadContext(new TextEncoder().encode(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSynthetic context\n",
    )),
    401,
    "context-file staging requires a Studio session",
  );
  const spikeFixture = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  await expectStatus(
    await probe.upload("/api/__studio-spike/upload", spikeFixture),
    401,
    "spike upload requires a Studio session",
  );
  for (const path of [
    join(spikeRoot, "stream-upload.partial"),
    join(spikeRoot, "stream-upload.sealed"),
  ]) {
    try {
      await stat(path);
      throw new Error("Unauthenticated spike upload wrote bytes.");
    } catch (error) {
      if (
        !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  }
  await expectStatus(
    await probe.bootstrap(bootstrapToken, {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }),
    403,
    "cross-site bootstrap fails closed",
  );
  await expectStatus(
    await fetch(`${baseUrl}/__studio/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({ token: "x".repeat(2_048) }),
    }),
    413,
    "oversized bootstrap fails closed",
  );

  const bootstrap = await expectStatus(
    await probe.bootstrap(bootstrapToken),
    200,
    "bootstrap exchange succeeds once",
  );
  const bootstrapBody = await bootstrap.json() as { redirect?: string };
  if (bootstrapBody.redirect !== "/connections") {
    throw new Error("Bootstrap did not return the clean Connections path.");
  }
  const jobs = await expectStatus(
    await probe.get("/api/studio/jobs"),
    200,
    "job runtime starts before authenticated routes accept work",
  );
  const jobsBody = await jobs.json() as { jobs?: Array<{ id?: string }> };
  if (
    !Array.isArray(jobsBody.jobs)
    || jobsBody.jobs.length !== 3
    || !jobsBody.jobs.some((job) => job.id === seededSucceededJobId)
  ) {
    throw new Error("Fresh Studio job runtime did not preserve the terminal fixture.");
  }
  const supportReceiptResponse = await expectStatus(
    await probe.get(`/api/studio/jobs/${seededSucceededJobId}/support-receipt`),
    200,
    "authenticated support receipt is available for the same job",
  );
  if (!supportReceiptResponse.headers.get("content-type")?.startsWith("text/plain")) {
    throw new Error("Support receipt did not use a plain-text response type.");
  }
  const supportReceipt = await supportReceiptResponse.text();
  if (
    !supportReceipt.startsWith("Frame of Mind support receipt v1\n")
    || !supportReceipt.includes(`job_id=${seededSucceededJobId}`)
    || !supportReceipt.includes("stage=succeeded")
    || !supportReceipt.includes("recipe_id=issue-review")
    || supportReceipt.includes("idempotencyKey")
    || supportReceipt.includes(DEFAULT_GEMINI_MODEL)
    || supportReceipt.includes(outputRoot)
  ) {
    throw new Error("Support receipt did not preserve its closed allowlist.");
  }
  await expectStatus(
    await probe.get("/api/studio/jobs/job_missing_support_receipt/support-receipt"),
    404,
    "missing support receipt id returns not found",
  );
  const maintenanceResponse = await expectStatus(
    await probe.get("/api/studio/maintenance"),
    200,
    "authenticated maintenance diagnostics are available",
  );
  const maintenance = await maintenanceResponse.json() as {
    plan?: { generatedAt?: string; actions?: unknown[] };
    lastRun?: {
      applied?: number;
      removed?: number;
      staleJobs?: number;
      failures?: unknown[];
    };
  };
  if (
    !maintenance.plan?.generatedAt
    || !Array.isArray(maintenance.plan.actions)
    || maintenance.plan.actions.length !== 0
    || maintenance.lastRun?.applied !== 1
    || maintenance.lastRun.removed !== 1
    || maintenance.lastRun.staleJobs !== 0
    || !Array.isArray(maintenance.lastRun.failures)
  ) {
    throw new Error("Maintenance diagnostics did not return a sanitized dry-run plan and summary.");
  }
  await expectStatus(
    await probe.mutate(
      "/api/studio/jobs/job_01K123456789ABC/cancel",
      "POST",
      {},
      {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    ),
    403,
    "cross-site job cancellation fails closed",
  );
  await expectStatus(
    await probe.bootstrap(bootstrapToken),
    403,
    "bootstrap replay fails closed",
  );
  await expectStatus(
    await probe.get("/api/studio/session"),
    200,
    "session cookie authorizes Studio APIs",
  );
  const spikeUpload = await expectStatus(
    await probe.upload("/api/__studio-spike/upload", spikeFixture),
    200,
    "session cookie authorizes the spike upload",
  );
  const spikeReceipt = await spikeUpload.json() as {
    receivedBytes?: number;
    sha256?: string;
  };
  if (
    spikeReceipt.receivedBytes !== spikeFixture.byteLength
    || spikeReceipt.sha256
      !== createHash("sha256").update(spikeFixture).digest("hex")
    || (await stat(join(spikeRoot, "stream-upload.sealed"))).size
      !== spikeFixture.byteLength
  ) {
    throw new Error("Authenticated spike upload did not preserve its byte contract.");
  }
  const retainedMediaPath = `/api/runs/${encodeURIComponent(runFixture.manifest.runId)}/media`;
  const retainedStatus = await expectStatus(
    await probe.get(`/api/runs/${encodeURIComponent(runFixture.manifest.runId)}/media-status`),
    200,
    "retained media status reports availability without reading bytes",
  );
  if ((await retainedStatus.json() as { available?: boolean }).available !== true) {
    throw new Error("Retained media status did not report the live receipt.");
  }
  const retainedRange = await expectStatus(
    await probe.get(retainedMediaPath, { range: "bytes=4-11" }),
    206,
    "retained media serves one authenticated byte range",
  );
  if (
    retainedRange.headers.get("content-range") !== "bytes 4-11/64"
    || retainedRange.headers.get("content-length") !== "8"
    || retainedRange.headers.get("content-type") !== "video/mp4"
    || retainedRange.headers.get("content-disposition") !== "inline"
    || retainedRange.headers.get("accept-ranges") !== "bytes"
    || retainedRange.headers.get("cache-control") !== "no-store"
    || retainedRange.headers.get("x-content-type-options") !== "nosniff"
    || !Buffer.from(await retainedRange.arrayBuffer())
      .equals(Buffer.from(retainedFixture.slice(4, 12)))
  ) {
    throw new Error("Retained media range response did not match its sealed receipt.");
  }
  const overlappingRanges = await Promise.all([
    probe.get(retainedMediaPath, { range: "bytes=0-31" }),
    probe.get(retainedMediaPath, { range: "bytes=16-47" }),
  ]);
  await Promise.all(overlappingRanges.map((response, index) => expectStatus(
    response,
    206,
    `overlapping retained media range ${index + 1} streams concurrently`,
  )));
  const overlappingBodies = await Promise.all(overlappingRanges.map(
    (response) => response.arrayBuffer(),
  ));
  if (
    !Buffer.from(overlappingBodies[0]!)
      .equals(Buffer.from(retainedFixture.slice(0, 32)))
    || !Buffer.from(overlappingBodies[1]!)
      .equals(Buffer.from(retainedFixture.slice(16, 48)))
  ) {
    throw new Error("Overlapping retained media ranges returned incorrect bytes.");
  }
  const retainedFull = await expectStatus(
    await probe.get(retainedMediaPath),
    200,
    "retained media supports a full streaming GET",
  );
  if (
    retainedFull.headers.get("content-length") !== "64"
    || !Buffer.from(await retainedFull.arrayBuffer()).equals(Buffer.from(retainedFixture))
  ) {
    throw new Error("Retained media full response did not match its sealed bytes.");
  }
  for (const [range, label] of [
    ["bytes=0-1,4-5", "multiple ranges"],
    ["bytes=--1", "negative ranges"],
    ["bytes=999999999999999999999-", "overflow ranges"],
  ] as const) {
    const rejected = await expectStatus(
      await probe.get(retainedMediaPath, { range }),
      416,
      `retained media rejects ${label}`,
    );
    if (rejected.headers.get("content-range") !== "bytes */64") {
      throw new Error(`Rejected ${label} omitted the authoritative size.`);
    }
  }
  await expectStatus(
    await probe.head(retainedMediaPath),
    405,
    "retained media rejects HEAD",
  );
  await expectStatus(
    await probe.get(retainedMediaPath, {
      range: "bytes=0-3",
      "if-range": "synthetic-etag",
    }),
    400,
    "retained media rejects If-Range",
  );
  await expectStatus(
    await probe.get("/api/runs/run_http_unknown_media_0001/media", {
      range: "bytes=0-3",
    }),
    404,
    "unknown run media is not found",
  );
  await expectStatus(
    await probe.get("/api/runs/..%5Cprivate/media", { range: "bytes=0-3" }),
    404,
    "path traversal in a run identifier is not found",
  );
  await expectStatus(
    await probe.get("/api/runs/run_http_expired_media_0001/media", {
      range: "bytes=0-3",
    }),
    404,
    "expired retained media is not found",
  );
  const expiredStatus = await expectStatus(
    await probe.get("/api/runs/run_http_expired_media_0001/media-status"),
    200,
    "expired retained media status remains a non-error read",
  );
  if ((await expiredStatus.json() as { available?: boolean }).available !== false) {
    throw new Error("Expired retained media status claimed playback availability.");
  }
  await expectStatus(
    await probe.mutate("/api/runs", "POST", runFixture),
    201,
    "review reattachment reads an imported manifest projection",
  );
  await expectStatus(
    await probe.mutate(`/api/studio/media/${retainedMedia.id}`, "DELETE", {}),
    200,
    "retained review fixture can be removed before explicit reattachment",
  );
  const unavailableAfterDelete = await expectStatus(
    await probe.get(`/api/runs/${encodeURIComponent(runFixture.manifest.runId)}/media-status`),
    200,
    "deleted run media reports unavailable before reattachment",
  );
  if ((await unavailableAfterDelete.json() as { available?: boolean }).available !== false) {
    throw new Error("Deleted run media remained available before reattachment.");
  }

  const mismatchedFixture = retainedFixture.slice();
  mismatchedFixture[mismatchedFixture.length - 1] ^= 0xff;
  const mismatchedCreate = await expectStatus(
    await probe.mutate("/api/studio/media", "POST", {
      idempotencyKey: "studio-http-review-reattach-mismatch-0001",
      expectedBytes: mismatchedFixture.byteLength,
      mimeType: "video/mp4",
      retention: { mode: "retained", ttlSeconds: 24 * 60 * 60 },
    }),
    201,
    "mismatched review reattachment creates private staging",
  );
  const mismatchedMedia = await mismatchedCreate.json() as { id: string };
  await expectStatus(
    await probe.upload(
      `/api/studio/media/${mismatchedMedia.id}/parts/0`,
      mismatchedFixture,
      { "upload-offset": "0" },
    ),
    200,
    "mismatched review fixture streams to private staging",
  );
  const mismatchedComplete = await expectStatus(
    await probe.mutate(
      `/api/studio/media/${mismatchedMedia.id}/complete`,
      "POST",
      { expectedSha256: retainedDigest },
    ),
    422,
    "streamed review digest mismatch fails closed",
  );
  if (!(await mismatchedComplete.text()).includes("digest_mismatch")) {
    throw new Error("Review digest mismatch omitted its sanitized code.");
  }
  const mismatchedDeleted = await expectStatus(
    await probe.mutate(`/api/studio/media/${mismatchedMedia.id}`, "DELETE", {}),
    200,
    "mismatched review staging is deleted",
  );
  if ((await mismatchedDeleted.json() as { status?: string }).status !== "deleted") {
    throw new Error("Mismatched review staging remained retained.");
  }

  const matchingCreate = await expectStatus(
    await probe.mutate("/api/studio/media", "POST", {
      idempotencyKey: "studio-http-review-reattach-match-0001",
      expectedBytes: retainedFixture.byteLength,
      mimeType: "video/mp4",
      retention: { mode: "retained", ttlSeconds: 24 * 60 * 60 },
    }),
    201,
    "matching review reattachment creates private staging",
  );
  const matchingMedia = await matchingCreate.json() as { id: string };
  await expectStatus(
    await probe.upload(
      `/api/studio/media/${matchingMedia.id}/parts/0`,
      retainedFixture,
      { "upload-offset": "0" },
    ),
    200,
    "matching review fixture streams to private staging",
  );
  await expectStatus(
    await probe.mutate(
      `/api/studio/media/${matchingMedia.id}/complete`,
      "POST",
      { expectedSha256: retainedDigest },
    ),
    200,
    "matching review digest seals only after streamed verification",
  );
  const matchingBound = await expectStatus(
    await probe.mutate(
      `/api/runs/${encodeURIComponent(runFixture.manifest.runId)}/media/reattach`,
      "POST",
      { mediaSessionId: matchingMedia.id },
    ),
    200,
    "matching review media binds to the imported run",
  );
  if ((await matchingBound.json() as { status?: string }).status !== "retained") {
    throw new Error("Matching review media was not retained after binding.");
  }
  const reattachedStatus = await expectStatus(
    await probe.get(`/api/runs/${encodeURIComponent(runFixture.manifest.runId)}/media-status`),
    200,
    "reattached review media becomes available",
  );
  if ((await reattachedStatus.json() as { available?: boolean }).available !== true) {
    throw new Error("Verified reattached media did not enable playback.");
  }
  const reattachedRange = await expectStatus(
    await probe.get(`/api/runs/${encodeURIComponent(runFixture.manifest.runId)}/media`, {
      range: "bytes=8-15",
    }),
    206,
    "reattached review media serves verified bytes",
  );
  if (!Buffer.from(await reattachedRange.arrayBuffer())
    .equals(Buffer.from(retainedFixture.slice(8, 16)))) {
    throw new Error("Reattached review media bytes did not match the manifest digest.");
  }
  await expectStatus(
    await probe.get("/api/runs/run_http_cleaned_media_0001/media", {
      range: "bytes=0-3",
    }),
    404,
    "ephemeral cleaned media is not found",
  );
  const studioPage = await expectStatus(
    await probe.get("/"),
    200,
    "authenticated Studio Home renders",
  );
  const studioHtml = await studioPage.text();
  if (
    !studioHtml.includes('data-studio-shell="local"')
    || !studioHtml.includes("Studio navigation")
    || !studioHtml.includes('data-studio-home="local"')
  ) {
    throw new Error("Authenticated Studio Home did not render the local dashboard shell.");
  }
  const contextPage = await expectStatus(
    await probe.get("/context"),
    200,
    "authenticated Context page renders",
  );
  const contextHtml = await contextPage.text();
  if (
    !contextHtml.includes('data-context-step="local"')
    || !contextHtml.includes("Pair the recording with what was said.")
  ) {
    throw new Error("Authenticated Context page did not render its local composer step.");
  }
  const intentPage = await expectStatus(
    await probe.get("/intent"),
    200,
    "authenticated Intent page renders",
  );
  const intentHtml = await intentPage.text();
  if (
    !intentHtml.includes('data-intent-step="local"')
    || !intentHtml.includes("Choose what this analysis should find.")
  ) {
    throw new Error("Authenticated Intent page did not render its local composer step.");
  }
  const runPage = await expectStatus(
    await probe.get("/run"),
    200,
    "authenticated Run receipt page renders",
  );
  const runHtml = await runPage.text();
  if (
    !runHtml.includes('data-run-step="local"')
    || !runHtml.includes("Review the exact run receipt.")
  ) {
    throw new Error("Authenticated Run page did not render its receipt shell.");
  }
  const activityPage = await expectStatus(
    await probe.get("/activity"),
    200,
    "authenticated Activity page renders",
  );
  const activityHtml = await activityPage.text();
  if (
    !activityHtml.includes('data-activity-page="local"')
    || !activityHtml.includes("Follow each private local job")
  ) {
    throw new Error("Authenticated Activity page did not render its local list shell.");
  }
  const activityDetailPage = await expectStatus(
    await probe.get("/activity/job_01K123456789ABC"),
    200,
    "authenticated Activity detail page renders",
  );
  const activityDetailHtml = await activityDetailPage.text();
  if (
    !activityDetailHtml.includes('data-activity-detail="local"')
    || !activityDetailHtml.includes("All activity")
  ) {
    throw new Error(
      "Authenticated Activity detail page did not render its local detail shell.",
    );
  }
  const recipesResponse = await expectStatus(
    await probe.get("/api/studio/recipes"),
    200,
    "authenticated recipe catalog renders",
  );
  const recipesText = await recipesResponse.text();
  const recipesBody = JSON.parse(recipesText) as {
    defaultModel?: string;
    recipes?: Array<{ id?: string; label?: string; description?: string; revision?: string }>;
  };
  if (
    recipesBody.defaultModel !== DEFAULT_GEMINI_MODEL
    || !recipesBody.recipes?.some((recipe) => recipe.id === "requirements")
    || recipesText.includes("indexInstruction")
    || recipesText.includes("interrogationInstruction")
  ) {
    throw new Error("Recipe catalog exposed an invalid or unsafe projection.");
  }

  const fixture = new Uint8Array(20);
  fixture.set([0x00, 0x00, 0x00, 0x18], 0);
  fixture.set(new TextEncoder().encode("ftypisom"), 4);
  const createMediaBody = {
    idempotencyKey: "studio-http-media-0001",
    expectedBytes: fixture.byteLength,
    mimeType: "video/mp4",
    retention: { mode: "ephemeral" },
  };
  await expectStatus(
    await probe.mutate(
      "/api/studio/media",
      "POST",
      createMediaBody,
      {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    ),
    403,
    "cross-site media creation fails closed",
  );
  const created = await expectStatus(
    await probe.mutate("/api/studio/media", "POST", createMediaBody),
    201,
    "authenticated media creation succeeds",
  );
  const media = await created.json() as {
    id: string;
    status: string;
    partSizeBytes: number;
  };
  if (
    !media.id.startsWith("media_")
    || media.status !== "created"
    || media.partSizeBytes < fixture.byteLength
  ) {
    throw new Error("Media creation returned an invalid resumable receipt.");
  }
  const cleanupFixtureResponse = await expectStatus(
    await probe.mutate("/api/studio/media", "POST", {
      ...createMediaBody,
      idempotencyKey: "studio-http-media-cleanup-0001",
    }),
    201,
    "cleanup fixture creates a media receipt",
  );
  const cleanupFixture = await cleanupFixtureResponse.json() as { id: string };
  const cleanupRetryForbidden = await expectStatus(
    await probe.mutate(
      `/api/studio/media/${cleanupFixture.id}/cleanup-retry`,
      "POST",
      {},
    ),
    409,
    "cleanup retry rejects a media session without a cleanup failure",
  );
  if (!(await cleanupRetryForbidden.text()).includes("media_cleanup_not_retryable")) {
    throw new Error("Cleanup retry state rejection omitted its sanitized code.");
  }
  const obstructingPath = join(
    mediaRoot,
    "sessions",
    cleanupFixture.id,
    "media.partial",
  );
  await mkdir(obstructingPath);
  await expectStatus(
    await probe.mutate(`/api/studio/media/${cleanupFixture.id}`, "DELETE", {}),
    503,
    "failed deletion preserves a cleanup failure receipt",
  );
  const failedCleanupStatus = await expectStatus(
    await probe.get(`/api/studio/media/${cleanupFixture.id}`),
    200,
    "cleanup failure remains readable",
  );
  if ((await failedCleanupStatus.json() as { status?: string }).status !== "cleanup_failed") {
    throw new Error("Failed deletion did not preserve cleanup_failed state.");
  }
  await rm(obstructingPath, { recursive: true, force: true });
  const cleanupRetried = await expectStatus(
    await probe.mutate(
      `/api/studio/media/${cleanupFixture.id}/cleanup-retry`,
      "POST",
      {},
    ),
    200,
    "cleanup retry deletes only after the adapter confirms deletion",
  );
  if ((await cleanupRetried.json() as { status?: string }).status !== "deleted") {
    throw new Error("Cleanup retry claimed success without a deleted receipt.");
  }
  await expectStatus(
    await probe.upload(
      `/api/studio/media/${media.id}/parts/0`,
      fixture,
      { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    ),
    403,
    "cross-site media upload fails closed",
  );
  await expectStatus(
    await probe.upload(`/api/studio/media/${media.id}/parts/0`, fixture),
    422,
    "media upload requires an explicit offset",
  );
  const uploaded = await expectStatus(
    await probe.upload(
      `/api/studio/media/${media.id}/parts/0`,
      fixture,
      { "upload-offset": "0" },
    ),
    200,
    "streamed media part succeeds",
  );
  const uploadReceipt = await uploaded.json() as {
    replayed: boolean;
    session: { receivedBytes: number };
  };
  if (
    uploadReceipt.replayed
    || uploadReceipt.session.receivedBytes !== fixture.byteLength
  ) {
    throw new Error("Media upload receipt did not acknowledge durable bytes.");
  }
  const replay = await expectStatus(
    await probe.upload(
      `/api/studio/media/${media.id}/parts/0`,
      fixture,
      { "upload-offset": "0" },
    ),
    200,
    "identical media part retry replays safely",
  );
  if (!(await replay.json() as { replayed: boolean }).replayed) {
    throw new Error("Media part retry was not identified as a replay.");
  }
  const mediaStatus = await expectStatus(
    await probe.get(`/api/studio/media/${media.id}`),
    200,
    "media status supports resumable clients",
  );
  if (
    (await mediaStatus.json() as { receivedBytes: number }).receivedBytes
      !== fixture.byteLength
  ) {
    throw new Error("Media status did not expose the durable byte receipt.");
  }
  const complete = await expectStatus(
    await probe.mutate(
      `/api/studio/media/${media.id}/complete`,
      "POST",
      {
        expectedSha256: createHash("sha256").update(fixture).digest("hex"),
      },
    ),
    200,
    "complete verifies and seals streamed media",
  );
  const completeBody = await complete.json() as {
    sha256: string;
    bytes: number;
  };
  if (
    completeBody.bytes !== fixture.byteLength
    || completeBody.sha256
      !== createHash("sha256").update(fixture).digest("hex")
  ) {
    throw new Error("Media completion returned an invalid seal receipt.");
  }

  const requirementsRecipe = recipesBody.recipes?.find(
    (recipe) => recipe.id === "requirements",
  );
  if (!requirementsRecipe?.revision) {
    throw new Error("Recipe catalog omitted the requirements revision.");
  }
  const composerBody = {
    idempotencyKey: "studio-http-composer-0001",
    mediaSessionId: media.id,
    context: { mode: "none" },
    recipe: {
      id: "requirements",
      revision: requirementsRecipe.revision,
    },
    model: DEFAULT_GEMINI_MODEL,
    retention: { mode: "ephemeral" },
  };
  const invalidContext = await expectStatus(
    await probe.mutate(
      "/api/studio/composer/jobs",
      "POST",
      { ...composerBody, context: { mode: "enriched" } },
    ),
    422,
    "composer rejects malformed context shapes",
  );
  const invalidContextText = await invalidContext.text();
  if (
    !invalidContextText.includes("invalid_job_request")
    || invalidContextText.includes(mediaRoot)
    || invalidContextText.includes("transcript")
  ) {
    throw new Error("Invalid composer context response was not sanitized.");
  }

  const customRejected = await expectStatus(
    await probe.mutate(
      "/api/studio/composer/jobs",
      "POST",
      {
        ...composerBody,
        recipe: {
          custom: {
            id: "synthetic-review",
            label: "Synthetic review",
            description: "Review a synthetic fixture.",
            indexInstruction: "Find synthetic evidence.",
            interrogationInstruction: "Verify synthetic evidence.",
          },
        },
      },
    ),
    409,
    "composer rejects custom recipe before insertion",
  );
  if (!(await customRejected.text()).includes("custom_recipe_staging_unavailable")) {
    throw new Error("Custom recipe rejection omitted its sanitized code.");
  }

  const mismatchRejected = await expectStatus(
    await probe.mutate(
      "/api/studio/composer/jobs",
      "POST",
      {
        ...composerBody,
        recipe: { id: "requirements", revision: "stale-revision" },
      },
    ),
    409,
    "composer rejects stale recipe revision before insertion",
  );
  if (!(await mismatchRejected.text()).includes("recipe_receipt_mismatch")) {
    throw new Error("Recipe mismatch rejection omitted its sanitized code.");
  }

  const beforeCreate = await expectStatus(
    await probe.get("/api/studio/jobs"),
    200,
    "rejected composer inputs do not insert jobs",
  );
  if ((await beforeCreate.json() as { jobs: unknown[] }).jobs.length !== 3) {
    throw new Error("Rejected composer input inserted a job.");
  }

  const unconfiguredComposer = await expectStatus(
    await probe.mutate("/api/studio/composer/jobs", "POST", composerBody),
    409,
    "composer fails closed without Gemini configuration",
  );
  if (!(await unconfiguredComposer.text()).includes("gemini_not_configured")) {
    throw new Error("Unconfigured composer rejection omitted its sanitized code.");
  }
  const afterUnconfigured = await expectStatus(
    await probe.get("/api/studio/jobs"),
    200,
    "unconfigured composer input does not insert a job",
  );
  if ((await afterUnconfigured.json() as { jobs: unknown[] }).jobs.length !== 3) {
    throw new Error("Unconfigured composer input inserted a job.");
  }

  const syntheticGeminiKey = "synthetic-http-gemini-key-never-use";
  await expectStatus(
    await probe.mutate(
      "/api/studio/configuration/secrets/gemini-api-key",
      "PUT",
      { value: syntheticGeminiKey },
    ),
    200,
    "composer fixture installs a synthetic Gemini key",
  );
  try {
    const composerCreated = await expectStatus(
      await probe.mutate("/api/studio/composer/jobs", "POST", composerBody),
      201,
      "validated composer receipt creates one job",
    );
    const createdJob = await composerCreated.json() as {
      kind: string;
      job: { id: string; input: Record<string, unknown> & { context: unknown } };
    };
    if (
      createdJob.kind !== "created"
      || !createdJob.job.id.startsWith("job_")
      || JSON.stringify(createdJob.job.input.context) !== JSON.stringify({ mode: "none" })
    ) {
      throw new Error("Composer creation returned an invalid job receipt.");
    }
    const reimportRejected = await expectStatus(
      await probe.mutate(
        `/api/studio/jobs/${createdJob.job.id}/reimport`,
        "POST",
        {},
      ),
      409,
      "re-import rejects a job that did not succeed",
    );
    if (!(await reimportRejected.text()).includes("job_not_succeeded")) {
      throw new Error("Re-import state rejection omitted its sanitized code.");
    }
    const composerReplay = await expectStatus(
      await probe.mutate("/api/studio/composer/jobs", "POST", composerBody),
      200,
      "same composer idempotency key replays the same job",
    );
    const replayedJob = await composerReplay.json() as {
      kind: string;
      job: { id: string };
    };
    if (
      replayedJob.kind !== "replayed"
      || replayedJob.job.id !== createdJob.job.id
    ) {
      throw new Error("Composer idempotency replay returned a different job.");
    }
    const conflictingReplay = await expectStatus(
      await probe.mutate("/api/studio/jobs", "POST", {
        idempotencyKey: composerBody.idempotencyKey,
        input: {
          ...createdJob.job.input,
          focus: "Changed input under an already-used key.",
        },
      }),
      409,
      "job API refuses a reused key with changed input",
    );
    const conflictingReplayText = await conflictingReplay.text();
    if (!conflictingReplayText.includes("idempotency_conflict")) {
      throw new Error("Job API idempotency conflict omitted its sanitized code.");
    }
  } finally {
    await expectStatus(
      await probe.mutate(
        "/api/studio/configuration/secrets/gemini-api-key",
        "DELETE",
        {},
      ),
      200,
      "composer fixture deletes its synthetic Gemini key",
    );
  }

  const unsealedMediaResponse = await expectStatus(
    await probe.mutate("/api/studio/media", "POST", {
      ...createMediaBody,
      idempotencyKey: "studio-http-media-unsealed-0001",
    }),
    201,
    "unsealed composer fixture creates a staging receipt",
  );
  const unsealedMedia = await unsealedMediaResponse.json() as { id: string };
  const unsealedRejected = await expectStatus(
    await probe.mutate("/api/studio/composer/jobs", "POST", {
      ...composerBody,
      idempotencyKey: "studio-http-composer-unsealed-0001",
      mediaSessionId: unsealedMedia.id,
    }),
    409,
    "composer rejects an unsealed media session",
  );
  if (!(await unsealedRejected.text()).includes("media_not_usable")) {
    throw new Error("Unsealed media rejection omitted its sanitized code.");
  }
  await expectStatus(
    await probe.mutate(`/api/studio/media/${unsealedMedia.id}`, "DELETE", {}),
    200,
    "unsealed composer fixture is deleted",
  );

  const imported = await expectStatus(
    await probe.mutate(
      `/api/studio/jobs/${seededSucceededJobId}/reimport`,
      "POST",
      {},
    ),
    200,
    "succeeded job re-imports its existing result files",
  );
  if ((await imported.json() as { runId?: string }).runId !== runFixture.manifest.runId) {
    throw new Error("Re-import did not return the succeeded job's run ID.");
  }
  await expectStatus(
    await probe.mutate(
      `/api/studio/jobs/${seededSucceededJobId}/reimport`,
      "POST",
      {},
    ),
    200,
    "re-import is idempotent",
  );
  await expectStatus(
    await probe.get(`/api/runs/${runFixture.manifest.runId}`),
    200,
    "re-import restores the review workspace result",
  );
  const reviewPage = await expectStatus(
    await probe.get(`/review/${encodeURIComponent(runFixture.manifest.runId)}`),
    200,
    "authenticated review workspace renders",
  );
  const reviewHtml = await reviewPage.text();
  if (
    !reviewHtml.includes('data-studio-review="local"')
    || !reviewHtml.includes("Analysis records")
    || !reviewHtml.includes("Candidate markers")
  ) {
    throw new Error("Authenticated review workspace omitted its local review shell.");
  }

  const composerMediaCleanup = await probe.mutate(
    `/api/studio/media/${media.id}`,
    "DELETE",
    {},
  );
  if (![200, 404, 409].includes(composerMediaCleanup.status)) {
    throw new Error(
      "Composer media cleanup returned an unexpected status: "
      + `${composerMediaCleanup.status} ${await composerMediaCleanup.text()}`,
    );
  }

  const contextBytes = new TextEncoder().encode(
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSynthetic context\n",
  );
  await expectStatus(
    await probe.uploadContext(contextBytes, {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }),
    403,
    "cross-site context staging fails closed",
  );
  await expectStatus(
    await probe.uploadContext(contextBytes, {
      "content-type": "application/json",
    }),
    415,
    "context format and MIME must agree",
  );
  const stagedContext = await expectStatus(
    await probe.uploadContext(contextBytes),
    201,
    "bounded context-file staging succeeds",
  );
  const contextReceiptText = await stagedContext.text();
  const contextReceipt = JSON.parse(contextReceiptText) as {
    id: string;
    format: string;
    bytes: number;
    sha256: string;
  };
  if (
    !contextReceipt.id.startsWith("context_")
    || contextReceipt.format !== "vtt"
    || contextReceipt.bytes !== contextBytes.byteLength
    || contextReceipt.sha256
      !== createHash("sha256").update(contextBytes).digest("hex")
    || contextReceiptText.includes("Synthetic context")
    || contextReceiptText.includes(mediaRoot)
  ) {
    throw new Error("Context staging returned an invalid or private receipt.");
  }
  const contextStatus = await expectStatus(
    await probe.get(`/api/context-files/${contextReceipt.id}`),
    200,
    "context receipt can be refresh-verified",
  );
  if ((await contextStatus.json() as { sha256?: string }).sha256
    !== contextReceipt.sha256) {
    throw new Error("Context status did not return the exact staged receipt.");
  }
  await expectStatus(
    await probe.mutate(
      `/api/context-files/${contextReceipt.id}`,
      "DELETE",
      {},
    ),
    204,
    "context delete removes only the private staged copy",
  );

  const secret = "studio-http-test-secret-value";
  await expectStatus(
    await probe.mutate(
      "/api/studio/configuration/secrets/gemini-api-key",
      "PUT",
      { value: secret },
      {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    ),
    403,
    "cross-site secret mutation fails closed",
  );
  const stored = await expectStatus(
    await probe.mutate(
      "/api/studio/configuration/secrets/gemini-api-key",
      "PUT",
      { value: secret },
    ),
    200,
    "same-origin secret mutation succeeds",
  );
  if ((await stored.text()).includes(secret)) {
    throw new Error("Configuration response reflected a submitted secret.");
  }
  await expectStatus(
    await probe.mutate(
      "/api/studio/configuration/secrets/gemini-api-key",
      "DELETE",
      {},
    ),
    200,
    "temporary secret deletion succeeds",
  );

  console.log("Local Studio HTTP contract passed.");
} finally {
  server.kill("SIGTERM");
  await server.exited;
  await isolation.cleanup();
}
