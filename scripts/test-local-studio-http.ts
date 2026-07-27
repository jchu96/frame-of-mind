import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bootstrapToken = "studio-http-test-bootstrap-capability-0123456789";
const port = 34_000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;
const mediaRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-http-media-"));
const environment = {
  ...process.env,
  FRAME_OF_MIND_STUDIO: "1",
  FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN: bootstrapToken,
  FRAME_OF_MIND_CHECKOUT_ROOT: process.cwd(),
  FRAME_OF_MIND_MEDIA_ROOT: mediaRoot,
  HOST: "127.0.0.1",
  NITRO_HOST: "127.0.0.1",
  PORT: String(port),
  NITRO_PORT: String(port),
  NUXT_SQLITE_PATH: join(mediaRoot, "studio.sqlite"),
};
delete environment.NITRO_UNIX_SOCKET;

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

const server = Bun.spawn(["bun", ".output/server/index.mjs"], {
  cwd: `${process.cwd()}/apps/web`,
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
    await probe.get("/connections"),
    200,
    "authenticated Studio page renders",
  );
  const studioHtml = await studioPage.text();
  if (
    !studioHtml.includes('data-studio-shell="local"')
    || !studioHtml.includes("Studio navigation")
  ) {
    throw new Error("Authenticated Studio page did not render the local dashboard shell.");
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
  await expectStatus(
    await probe.mutate(`/api/studio/media/${media.id}`, "DELETE", {}),
    200,
    "media abort deletes only the private staged copy",
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
