import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GEMINI_MODEL } from "../src/adapters/gemini-model";

const bootstrapToken = "studio-http-test-bootstrap-capability-0123456789";
const port = 34_000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;
const webRoot = join(process.cwd(), "apps", "web");
const mediaRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-http-media-"));
const environment = {
  ...process.env,
  FRAME_OF_MIND_STUDIO: "1",
  FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN: bootstrapToken,
  FRAME_OF_MIND_CHECKOUT_ROOT: process.cwd(),
  FRAME_OF_MIND_MEDIA_ROOT: mediaRoot,
  FRAME_OF_MIND_CONTEXT_ROOT: join(mediaRoot, "context"),
  HOST: "127.0.0.1",
  NITRO_HOST: "127.0.0.1",
  PORT: String(port),
  NITRO_PORT: String(port),
  NUXT_SQLITE_PATH: join(mediaRoot, "studio.sqlite"),
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

const server = Bun.spawn([
  "bun",
  "--preload",
  join(webRoot, ".output/server/sentry.server.config.mjs"),
  join(webRoot, ".output/server/index.mjs"),
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
  const jobsBody = await jobs.json() as { jobs?: unknown[] };
  if (!Array.isArray(jobsBody.jobs) || jobsBody.jobs.length !== 0) {
    throw new Error("Fresh Studio job runtime did not return an empty queue.");
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
  if ((await beforeCreate.json() as { jobs: unknown[] }).jobs.length !== 0) {
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
  if ((await afterUnconfigured.json() as { jobs: unknown[] }).jobs.length !== 0) {
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
  await rm(mediaRoot, { recursive: true, force: true });
}
