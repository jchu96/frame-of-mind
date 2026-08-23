import type { HostedMediaUploadSession } from "../../../workflows/src/media.js";

export class HostedMediaServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostedMediaServiceError";
  }
}

export interface HostedR2UploadedPart { partNumber: number; etag: string }
export interface HostedR2MultipartUpload {
  uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | Uint8Array): Promise<HostedR2UploadedPart>;
  complete(parts: HostedR2UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
}
export interface HostedR2Object {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag: string;
  range?: { offset: number; length: number };
}
export interface HostedR2Bucket {
  createMultipartUpload(key: string): Promise<HostedR2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): HostedR2MultipartUpload;
  get(key: string, options?: unknown): Promise<HostedR2Object | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array, options?: unknown): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
}

export function requireRetainedSession(
  session: HostedMediaUploadSession | undefined,
  now: string,
): asserts session is HostedMediaUploadSession & {
  r2ObjectKey: string;
  r2UploadId: string;
  r2CapabilityHash: string;
} {
  if (!session) throw new HostedMediaServiceError("hosted_media_not_found");
  if (
    session.retention !== "retained"
    || !session.r2ObjectKey
    || !session.r2UploadId
    || !session.r2CapabilityHash
    || session.r2CompletedAt
    || session.state !== "open"
    || Date.parse(session.sessionExpiresAt) <= Date.parse(now)
  ) {
    throw new HostedMediaServiceError("hosted_retained_capability_unavailable");
  }
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const exact = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", exact));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestR2Object(object: HostedR2Object): Promise<string> {
  interface DigestStreamInstance extends WritableStream<ArrayBuffer | ArrayBufferView> {
    readonly digest: Promise<ArrayBuffer>;
    readonly bytesWritten: number | bigint;
  }
  type DigestStreamConstructor = new (algorithm: string) => DigestStreamInstance;
  const DigestStream = (crypto as Crypto & { DigestStream?: DigestStreamConstructor })
    .DigestStream;
  if (!DigestStream) {
    throw new HostedMediaServiceError("hosted_retained_digest_unavailable");
  }
  const digestStream = new DigestStream("SHA-256");
  await object.body.pipeTo(digestStream as WritableStream<Uint8Array>);
  if (Number(digestStream.bytesWritten) !== object.size) {
    throw new HostedMediaServiceError("retained_media_seal_mismatch");
  }
  const digest = new Uint8Array(await digestStream.digest);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function principalObjectPrefix(principalSub: string): Promise<string> {
  return `principals/${(await sha256Hex(principalSub)).slice(0, 32)}`;
}
