import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, extname } from "node:path";

export const MAX_RECORDING_BYTES = 2_000_000_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_REDIRECTS = 5;
const ALLOWED_MEDIA_HOSTS = new Set(["files.app.bluedothq.com"]);

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function downloadFile(url: string, destination: string): Promise<{ mimeType?: string; bytes: number }> {
  await ensureDirectory(dirname(destination));
  let currentUrl = validateBluedotMediaUrl(url);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) throw new Error(`Recording redirect ${response.status} omitted a location.`);
    currentUrl = validateBluedotMediaUrl(new URL(location, currentUrl).toString());
    if (redirects === MAX_REDIRECTS) throw new Error("Recording download exceeded the redirect limit.");
  }
  if (!response) throw new Error("Recording download did not return a response.");
  if (!response.ok || !response.body) {
    throw new Error(`Recording download failed (${response.status} ${response.statusText}). Refresh the signed URL and retry.`);
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0] || undefined;
  if (mimeType && !mimeType.startsWith("video/") && !mimeType.startsWith("audio/") && mimeType !== "application/octet-stream") {
    throw new Error(`Recording host returned unexpected content type '${mimeType}'.`);
  }
  const declaredBytes = Number(response.headers.get("content-length") || "0");
  if (declaredBytes > MAX_RECORDING_BYTES) throw new Error("Recording exceeds the Gemini Files API 2 GB per-file limit.");
  let receivedBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_RECORDING_BYTES) callback(new Error("Recording exceeds the Gemini Files API 2 GB per-file limit."));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      limiter,
      createWriteStream(destination, { mode: 0o600 }),
    );
    await chmod(destination, 0o600);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  return {
    mimeType,
    bytes: (await stat(destination)).size,
  };
}

export function validateBluedotMediaUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Recording URL must use HTTPS.");
  if (url.username || url.password) throw new Error("Recording URL must not contain user-info credentials.");
  if (!ALLOWED_MEDIA_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Recording URL host '${url.hostname}' is not an allowed Bluedot media host.`);
  }
  return url;
}

export function mimeForPath(path: string, header?: string): string {
  if (header && header !== "application/octet-stream") return header;
  const ext = extname(path).toLowerCase();
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  throw new Error(
    `Unsupported recording extension '${ext || "(none)"}'. Use MP4, M4V, MOV, or WebM video.`,
  );
}

export function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function safePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (!sanitized || sanitized === "." || sanitized === ".." || windowsReserved.test(sanitized)) {
    return `meeting-${sha256Text(value).slice(0, 12)}`;
  }
  return sanitized;
}
