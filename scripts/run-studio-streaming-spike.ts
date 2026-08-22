import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURE_BYTES = 32 * 1_024 * 1_024;
const CHUNK_BYTES = 64 * 1_024;
const MAX_HEAP_GROWTH_BYTES = 16 * 1_024 * 1_024;

async function runChecked(command: string[], env: Record<string, string>) {
  const process = Bun.spawn(command, {
    cwd: resolve("."),
    env: { ...globalThis.process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await process.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}.`);
}

const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-studio-spike-"));
const bootstrapToken = randomBytes(32).toString("base64url");
const spikeEnv = {
  FRAME_OF_MIND_DB_DRIVER: "sqlite",
  FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN: bootstrapToken,
  FRAME_OF_MIND_STUDIO_SPIKE: "1",
  FRAME_OF_MIND_STUDIO_SPIKE_DIR: directory,
  NITRO_PRESET: "node-server",
};

let stopServer: (() => Promise<void>) | undefined;
try {
  await runChecked(["bun", "run", "--cwd", "apps/web", "build"], spikeEnv);

  const reservation = Bun.serve({
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  await reservation.stop(true);
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = Bun.spawn([
    "bun",
    "--preload",
    resolve("apps/web/.output/server/sentry.server.config.mjs"),
    resolve("apps/web/.output/server/index.mjs"),
  ], {
    cwd: resolve("."),
    env: {
      ...globalThis.process.env,
      ...spikeEnv,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  stopServer = async () => {
    server.kill();
    await server.exited;
  };

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      const stderr = await new Response(server.stderr).text();
      throw new Error(`Spike server exited before readiness: ${stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The listener is not ready yet.
    }
    await Bun.sleep(50);
  }
  if (!ready) throw new Error("Spike server did not become ready.");

  const sealed = join(directory, "stream-upload.sealed");
  const partial = join(directory, "stream-upload.partial");
  const unauthorizedFixture = new Uint8Array([0x66, 0x6f, 0x6d]);
  const unauthorized = await fetch(`${baseUrl}/api/__studio-spike/upload`, {
    method: "PUT",
    headers: {
      "content-length": String(unauthorizedFixture.byteLength),
      "content-type": "application/octet-stream",
    },
    body: unauthorizedFixture,
  });
  if (unauthorized.status !== 401) {
    throw new Error(
      `Unauthenticated spike upload returned ${unauthorized.status}, expected 401.`,
    );
  }
  for (const path of [partial, sealed]) {
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

  const exchange = await fetch(`${baseUrl}/__studio/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
    },
    body: JSON.stringify({ token: bootstrapToken }),
  });
  if (exchange.status !== 200) {
    throw new Error(`Studio bootstrap exchange failed (${exchange.status}).`);
  }
  const sessionCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
  if (!sessionCookie) {
    throw new Error("Studio bootstrap exchange did not set a session cookie.");
  }

  const chunk = new Uint8Array(CHUNK_BYTES);
  let remaining = FIXTURE_BYTES;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const length = Math.min(remaining, chunk.byteLength);
      controller.enqueue(length === chunk.byteLength ? chunk : chunk.subarray(0, length));
      remaining -= length;
    },
  });

  const upload = await fetch(`${baseUrl}/api/__studio-spike/upload`, {
    method: "PUT",
    headers: {
      "content-length": String(FIXTURE_BYTES),
      "content-type": "application/octet-stream",
      cookie: sessionCookie,
      origin: baseUrl,
    },
    body,
  });
  if (!upload.ok) {
    throw new Error(`Streaming upload failed (${upload.status}): ${await upload.text()}`);
  }
  const receipt = await upload.json() as {
    receivedBytes: number;
    chunks: number;
    sha256: string;
    startHeapBytes: number;
    peakHeapBytes: number;
    startRssBytes: number;
    peakRssBytes: number;
  };

  const expectedHash = createHash("sha256");
  for (let offset = 0; offset < FIXTURE_BYTES; offset += CHUNK_BYTES) {
    expectedHash.update(chunk);
  }
  const expectedSha256 = expectedHash.digest("hex");
  if (receipt.receivedBytes !== FIXTURE_BYTES) {
    throw new Error("Server receipt did not preserve the exact byte count.");
  }
  if (receipt.sha256 !== expectedSha256) {
    throw new Error("Server receipt digest did not match the streamed fixture.");
  }
  if (receipt.chunks <= 1) {
    throw new Error("Server observed a single buffered request chunk.");
  }

  const heapGrowthBytes = receipt.peakHeapBytes - receipt.startHeapBytes;
  const rssGrowthBytes = receipt.peakRssBytes - receipt.startRssBytes;
  if (heapGrowthBytes >= MAX_HEAP_GROWTH_BYTES) {
    throw new Error(
      `Heap grew ${heapGrowthBytes} bytes for a ${FIXTURE_BYTES}-byte stream.`,
    );
  }

  if ((await stat(sealed)).size !== FIXTURE_BYTES) {
    throw new Error("Atomic seal did not produce the expected file.");
  }
  try {
    await stat(partial);
    throw new Error("Partial file remained after atomic seal.");
  } catch (error) {
    if (
      !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }

  const range = await fetch(`${baseUrl}/api/__studio-spike/media`, {
    headers: { cookie: sessionCookie, range: "bytes=1024-2047" },
  });
  if (range.status !== 206) throw new Error(`Expected 206, received ${range.status}.`);
  if (range.headers.get("content-range") !== `bytes 1024-2047/${FIXTURE_BYTES}`) {
    throw new Error("Byte-range response returned an incorrect Content-Range.");
  }
  if ((await range.arrayBuffer()).byteLength !== 1_024) {
    throw new Error("Byte-range response returned an incorrect body length.");
  }

  const unsatisfiable = await fetch(`${baseUrl}/api/__studio-spike/media`, {
    headers: { cookie: sessionCookie, range: `bytes=${FIXTURE_BYTES}-` },
  });
  if (unsatisfiable.status !== 416) {
    throw new Error(`Expected 416, received ${unsatisfiable.status}.`);
  }

  const webPackage = await Bun.file("apps/web/package.json").json() as {
    dependencies: { nuxt: string };
  };
  console.log(JSON.stringify({
    bunVersion: Bun.version,
    nuxtVersion: webPackage.dependencies.nuxt,
    fixtureBytes: FIXTURE_BYTES,
    requestChunks: receipt.chunks,
    heapGrowthBytes,
    rssGrowthBytes,
    sha256: receipt.sha256,
    atomicSeal: true,
    byteRange: true,
  }, null, 2));
} finally {
  await stopServer?.();
  await rm(directory, { recursive: true, force: true });
}
