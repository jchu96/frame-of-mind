import { createSHA256 } from "hash-wasm";
import { getHeader, getRequestWebStream } from "h3";

const hostedStreamSpikeMarker = "FRAME_OF_MIND_HOSTED_STREAM_SPIKE_ROUTE_V1";
const minimumSpikeBytes = 8 * 1024 * 1024;
const maximumSpikeBytes = 16 * 1024 * 1024;

interface HeapSignal {
  used: number;
  total: number;
  limit: number;
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const enabledValue: unknown = config.hostedStreamSpikeEnabled;
  const enabled = enabledValue === true || enabledValue === "true" || enabledValue === "1";
  if (!enabled) {
    throw createError({ statusCode: 404, statusMessage: "Not found." });
  }

  const sinkUrl = parseLoopbackSinkUrl(String(config.hostedStreamSpikeSinkUrl || ""));
  const contentLength = parseIntegerHeader(getHeader(event, "content-length"), "Content-Length");
  if (contentLength < minimumSpikeBytes || contentLength > maximumSpikeBytes) {
    throw createError({
      statusCode: 413,
      statusMessage: `Spike bodies must be between ${minimumSpikeBytes} and ${maximumSpikeBytes} bytes.`,
    });
  }
  const contentRange = getHeader(event, "content-range") || "";
  const range = parseContentRange(contentRange);
  if (range.length !== contentLength) {
    throw createError({ statusCode: 400, statusMessage: "Content-Range length does not match Content-Length." });
  }
  const uploadId = getHeader(event, "x-spike-upload-id")?.trim() || "";
  if (!/^[a-z0-9-]{1,64}$/.test(uploadId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid spike upload ID." });
  }

  const requestBody = getRequestWebStream(event);
  if (!requestBody) {
    throw createError({ statusCode: 400, statusMessage: "A raw request body is required." });
  }

  const upstreamRequest = event.context.cloudflare?.request as Request | undefined;
  const upstreamBodyUsedAtHandler = upstreamRequest?.bodyUsed ?? null;
  const heapBefore = readHeapSignal();
  const hasher = await createStreamingHasher();
  let forwardedBytes = 0;
  let routeDigest = "";
  const hashingStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      forwardedBytes += chunk.byteLength;
      hasher.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      routeDigest = hasher.digest();
    },
  });

  const sinkResponse = await fetch(sinkUrl, {
    method: "POST",
    headers: {
      "content-length": String(contentLength),
      "content-range": contentRange,
      "content-type": "application/octet-stream",
      "x-spike-upload-id": uploadId,
    },
    body: requestBody.pipeThrough(hashingStream),
  });
  const sinkReceipt = await readSinkReceipt(sinkResponse);
  if (!routeDigest && hasher.implementation === "sink-receipt-fallback") {
    routeDigest = sinkReceipt.sha256;
  }
  if (forwardedBytes !== contentLength || sinkReceipt.bytes !== contentLength) {
    throw createError({ statusCode: 502, statusMessage: "Spike sink byte receipt mismatch." });
  }
  if (!routeDigest || sinkReceipt.sha256 !== routeDigest) {
    throw createError({ statusCode: 502, statusMessage: "Spike sink digest receipt mismatch." });
  }

  return {
    marker: hostedStreamSpikeMarker,
    uploadId,
    bytes: forwardedBytes,
    sha256: routeDigest,
    contentRange,
    sink: sinkReceipt,
    runtime: {
      upstreamBodyUsedAtHandler,
      hashImplementation: hasher.implementation,
      hashWasmFailure: hasher.hashWasmFailure,
      heapBefore,
      heapAfter: readHeapSignal(),
    },
  };
});

async function createStreamingHasher(): Promise<{
  implementation: "hash-wasm" | "sink-receipt-fallback";
  hashWasmFailure: "runtime_compile_disallowed" | null;
  update: (chunk: Uint8Array) => void;
  digest: () => string;
}> {
  try {
    const hasher = await createSHA256();
    return {
      implementation: "hash-wasm",
      hashWasmFailure: null,
      update: (chunk) => { hasher.update(chunk); },
      digest: () => hasher.digest("hex"),
    };
  } catch {
    return {
      implementation: "sink-receipt-fallback",
      hashWasmFailure: "runtime_compile_disallowed",
      update: () => {},
      digest: () => "",
    };
  }
}

function parseIntegerHeader(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) {
    throw createError({ statusCode: 411, statusMessage: `${label} is required.` });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw createError({ statusCode: 400, statusMessage: `${label} is invalid.` });
  }
  return parsed;
}

function parseContentRange(value: string): { start: number; end: number; total: number; length: number } {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) {
    throw createError({ statusCode: 400, statusMessage: "A bounded Content-Range is required." });
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total) {
    throw createError({ statusCode: 400, statusMessage: "Content-Range is invalid." });
  }
  return { start, end, total, length: end - start + 1 };
}

function parseLoopbackSinkUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("not loopback HTTP");
    }
    return url.toString();
  } catch {
    throw createError({ statusCode: 503, statusMessage: "The hosted streaming spike sink is unavailable." });
  }
}

async function readSinkReceipt(response: Response): Promise<{ bytes: number; sha256: string }> {
  if (!response.ok) {
    throw createError({ statusCode: 502, statusMessage: "The hosted streaming spike sink rejected the body." });
  }
  const value = await response.json() as { bytes?: unknown; sha256?: unknown };
  if (
    !Number.isSafeInteger(value.bytes)
    || typeof value.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw createError({ statusCode: 502, statusMessage: "The hosted streaming spike sink returned an invalid receipt." });
  }
  return { bytes: value.bytes as number, sha256: value.sha256 };
}

function readHeapSignal(): HeapSignal | null {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
  }).memory;
  if (
    !memory
    || typeof memory.usedJSHeapSize !== "number"
    || typeof memory.totalJSHeapSize !== "number"
    || typeof memory.jsHeapSizeLimit !== "number"
  ) {
    return null;
  }
  return {
    used: memory.usedJSHeapSize,
    total: memory.totalJSHeapSize,
    limit: memory.jsHeapSizeLimit,
  };
}
