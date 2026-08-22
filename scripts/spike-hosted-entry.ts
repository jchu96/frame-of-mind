import { verifyCloudflareAccessJwt } from "../apps/web/server/utils/access";
import { normalizeTeamDomain } from "../apps/web/server/utils/auth-policy";

declare const nitro: {
  fetch(request: Request, env: HostedStreamEnv, context: unknown): Response | Promise<Response>;
};

const hostedStreamSpikeMarker = "FRAME_OF_MIND_HOSTED_STREAM_SPIKE_WRAPPER_V2";
const hostedUploadPath = "/api/_spike/stream";
const minimumSpikeBytes = 1 * 1024 * 1024;
const maximumSpikeBytes = 16 * 1024 * 1024;

interface HostedStreamEnv {
  NUXT_AUTH_MODE?: string;
  NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  NUXT_CLOUDFLARE_ACCESS_AUD?: string;
  NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS?: string;
  NUXT_HOSTED_STREAM_SPIKE_ENABLED?: string;
  NUXT_HOSTED_STREAM_SPIKE_SINK_URL?: string;
}

interface DigestStreamInstance extends WritableStream<ArrayBuffer | ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;
  readonly bytesWritten: number | bigint;
}

type DigestStreamConstructor = new (algorithm: string) => DigestStreamInstance;

export default {
  fetch(request: Request, env: HostedStreamEnv, context: unknown): Response | Promise<Response> {
    if (isHostedUploadRequest(request)) return handleRawUpload(request, env);
    return nitro.fetch(request, env, context);
  },
};

function isHostedUploadRequest(request: Request): boolean {
  return request.method === "POST" && normalizePathname(request.url) === hostedUploadPath;
}

async function handleRawUpload(request: Request, env: HostedStreamEnv): Promise<Response> {
  if (env.NUXT_HOSTED_STREAM_SPIKE_ENABLED !== "true") {
    return errorResponse(404, "Not found.");
  }

  const identity = await authenticateAccessRequest(request, env);
  if (identity instanceof Response) return identity;
  if (identity.principal.startsWith("service:")) {
    return errorResponse(403, "Service principals cannot use browser upload routes.");
  }

  const upstreamBodyUsedAtHandler = request.bodyUsed;
  const contentLength = parseIntegerHeader(request.headers.get("content-length"));
  if (contentLength instanceof Response) return contentLength;
  if (contentLength < minimumSpikeBytes || contentLength > maximumSpikeBytes) {
    return errorResponse(413, "Spike body is outside the bounded size range.");
  }

  const contentRange = request.headers.get("content-range") || "";
  const rangeLength = parseContentRangeLength(contentRange);
  if (rangeLength === null || rangeLength !== contentLength) {
    return errorResponse(400, "Content-Range is invalid or does not match Content-Length.");
  }
  const uploadId = request.headers.get("x-spike-upload-id")?.trim() || "";
  if (!/^[a-z0-9-]{1,64}$/.test(uploadId)) {
    return errorResponse(400, "Invalid spike upload ID.");
  }
  if (!request.body) return errorResponse(400, "A raw request body is required.");

  const sinkUrl = parseLoopbackSinkUrl(env.NUXT_HOSTED_STREAM_SPIKE_SINK_URL || "");
  if (!sinkUrl) return errorResponse(503, "The hosted streaming spike sink is unavailable.");
  const digestConstructor = (crypto as Crypto & {
    DigestStream?: DigestStreamConstructor;
  }).DigestStream;
  if (!digestConstructor) return errorResponse(503, "DigestStream is unavailable.");

  const digestStream = new digestConstructor("SHA-256");
  const digestWriter = digestStream.getWriter();
  const sinkAbort = new AbortController();
  let forwardedBytes = 0;
  let lengthFailure: "over_length" | "under_length" | null = null;
  const abortSink = () => sinkAbort.abort(request.signal.reason);
  request.signal.addEventListener("abort", abortSink, { once: true });
  const forwardingStream = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const nextBytes = forwardedBytes + chunk.byteLength;
      if (nextBytes > contentLength) {
        lengthFailure = "over_length";
        sinkAbort.abort(new Error("hosted_stream_over_length"));
        await digestWriter.abort(new Error("hosted_stream_over_length")).catch(() => undefined);
        throw new Error("hosted_stream_over_length");
      }
      forwardedBytes = nextBytes;
      await digestWriter.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      if (forwardedBytes !== contentLength) {
        lengthFailure = "under_length";
        sinkAbort.abort(new Error("hosted_stream_under_length"));
        await digestWriter.abort(new Error("hosted_stream_under_length")).catch(() => undefined);
        throw new Error("hosted_stream_under_length");
      }
      await digestWriter.close();
    },
  });
  let sinkResponse: Response;
  try {
    sinkResponse = await fetch(sinkUrl, {
      method: "POST",
      headers: {
        "content-range": contentRange,
        "content-type": "application/octet-stream",
        "x-spike-upload-id": uploadId,
      },
      body: request.body.pipeThrough(forwardingStream),
      signal: sinkAbort.signal,
    });
  } catch {
    sinkAbort.abort();
    await digestWriter.abort().catch(() => undefined);
    if (lengthFailure === "over_length") {
      return errorResponse(413, "The request body exceeds Content-Length.");
    }
    if (lengthFailure === "under_length") {
      return errorResponse(400, "The request body is shorter than Content-Length.");
    }
    return errorResponse(502, "The hosted streaming spike transfer failed.");
  } finally {
    request.signal.removeEventListener("abort", abortSink);
  }

  if (lengthFailure === "over_length") {
    return errorResponse(413, "The request body exceeds Content-Length.");
  }
  if (lengthFailure === "under_length") {
    return errorResponse(400, "The request body is shorter than Content-Length.");
  }
  const bytesWritten = Number(digestStream.bytesWritten);
  if (forwardedBytes !== contentLength || bytesWritten !== contentLength) {
    sinkAbort.abort(new Error("hosted_stream_length_receipt_mismatch"));
    return errorResponse(400, "The forwarded body does not match Content-Length.");
  }
  const sinkReceipt = await readSinkReceipt(sinkResponse);
  if (sinkReceipt instanceof Response) return sinkReceipt;
  const sha256 = toHex(await digestStream.digest);
  if (sinkReceipt.bytes !== contentLength) return errorResponse(502, "Spike sink byte receipt mismatch.");
  if (sinkReceipt.sha256 !== sha256) {
    return errorResponse(502, "Spike sink digest receipt mismatch.");
  }

  return Response.json({
    marker: hostedStreamSpikeMarker,
    uploadId,
    bytes: bytesWritten,
    sha256,
    contentRange,
    sink: sinkReceipt,
    runtime: {
      upstreamBodyUsedAtHandler,
      hashImplementation: "DigestStream",
    },
  });
}

function normalizePathname(value: string): string | null {
  try {
    const decoded = decodeURIComponent(new URL(value).pathname);
    const collapsed = decoded.replace(/\/{2,}/g, "/");
    return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  } catch {
    return null;
  }
}

async function authenticateAccessRequest(
  request: Request,
  env: HostedStreamEnv,
): Promise<{ principal: string } | Response> {
  if (env.NUXT_AUTH_MODE !== "cloudflare-access") {
    return errorResponse(503, "Authentication is misconfigured.");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  const audience = env.NUXT_CLOUDFLARE_ACCESS_AUD || "";
  if (!token || !audience) return errorResponse(403, "Cloudflare Access is required.");
  try {
    const teamDomain = normalizeTeamDomain(
      env.NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN,
      env.NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS === "true",
    );
    return await verifyCloudflareAccessJwt(token, teamDomain, audience);
  } catch {
    return errorResponse(403, "Cloudflare Access token is invalid.");
  }
}

function parseIntegerHeader(value: string | null): number | Response {
  if (!value || !/^\d+$/.test(value)) return errorResponse(411, "Content-Length is required.");
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? parsed
    : errorResponse(400, "Content-Length is invalid.");
}

function parseContentRangeLength(value: string): number | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total) {
    return null;
  }
  return end - start + 1;
}

function parseLoopbackSinkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function readSinkReceipt(response: Response): Promise<{ bytes: number; sha256: string } | Response> {
  if (!response.ok) return errorResponse(502, "The hosted streaming spike sink rejected the body.");
  try {
    const value = await response.json() as { bytes?: unknown; sha256?: unknown };
    if (
      !Number.isSafeInteger(value.bytes)
      || typeof value.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(value.sha256)
    ) {
      return errorResponse(502, "The hosted streaming spike sink returned an invalid receipt.");
    }
    return { bytes: value.bytes as number, sha256: value.sha256 };
  } catch {
    return errorResponse(502, "The hosted streaming spike sink returned an invalid receipt.");
  }
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ statusCode: status, statusMessage: message }, { status });
}
