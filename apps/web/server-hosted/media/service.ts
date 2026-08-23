import type { SealedHostedMediaReceipt } from "../../../workflows/src/contracts.js";
import { HostedMediaRepository } from "../../../workflows/src/media-repository.js";
import type {
  HostedMediaCreateRequest,
  HostedMediaCreateResponse,
  HostedMediaUploadSession,
} from "../../../workflows/src/media.js";
import { HostedWorkflowRepository } from "../../../workflows/src/repository.js";
import { HostedGeminiFilesClient } from "./provider.js";
import { opaqueIdSchema } from "../../../../src/domain/studio-identifiers.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STALE_SEAL_GRACE_MS = 2 * 60_000;

export class HostedMediaServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostedMediaServiceError";
  }
}

export class HostedMediaService {
  private readonly uploads: HostedMediaRepository;
  private readonly receipts: HostedWorkflowRepository;

  constructor(
    database: ConstructorParameters<typeof HostedMediaRepository>[0],
    private readonly provider: HostedGeminiFilesClient,
    private readonly apiKey: string,
    private readonly config: {
      openSessionCap: number;
      maxBytes: number;
      sessionTtlSeconds: number;
    },
  ) {
    this.uploads = new HostedMediaRepository(database);
    this.receipts = new HostedWorkflowRepository(database);
  }

  async create(
    principalSub: string,
    declaration: HostedMediaCreateRequest,
  ): Promise<HostedMediaCreateResponse> {
    if (declaration.declaredSizeBytes > this.config.maxBytes) {
      throw new HostedMediaServiceError("hosted_media_size_exceeded");
    }
    const now = new Date();
    const createdAt = now.toISOString();
    const sessionExpiresAt = new Date(
      now.getTime() + this.config.sessionTtlSeconds * 1_000,
    ).toISOString();
    const mediaId = `media_${crypto.randomUUID().replaceAll("-", "")}`;
    await this.uploads.reserve({
      principalSub,
      mediaId,
      declaration,
      openSessionCap: this.config.openSessionCap,
      createdAt,
      sessionExpiresAt,
    });
    let started: Awaited<ReturnType<HostedGeminiFilesClient["start"]>> | undefined;
    try {
      started = await this.provider.start({
        mediaId,
        sizeBytes: declaration.declaredSizeBytes,
        mimeType: declaration.mimeType,
      });
      const encrypted = await encryptCapability(
        started.uploadUrl,
        this.apiKey,
        principalSub,
        mediaId,
      );
      await this.uploads.activate({
        principalSub,
        mediaId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        providerPartBytes: started.partBytes,
        ...(started.geminiFileName
          ? { geminiFileName: started.geminiFileName }
          : {}),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.uploads.markCleanupFailed(
        principalSub,
        mediaId,
        new Date().toISOString(),
      );
      if (started) {
        await this.provider.abandon(
          started.uploadUrl,
          started.geminiFileName,
        ).catch(() => undefined);
      }
      throw error;
    }
    return {
      mediaId: opaqueIdSchema.parse(mediaId),
      uploadUrl: started.uploadUrl,
      partBytes: started.partBytes,
      sessionExpiresAt,
    };
  }

  async seal(
    principalSub: string,
    mediaId: string,
  ): Promise<SealedHostedMediaReceipt> {
    const now = new Date().toISOString();
    const session = await this.uploads.claimForSeal(principalSub, mediaId, now);
    if (session.state === "sealed") {
      const receipt = await this.receipts.getMediaReceipt(principalSub, mediaId);
      if (!receipt) throw new HostedMediaServiceError("sealed_media_receipt_missing");
      return receipt;
    }
    const uploadUrl = await this.decryptSessionUrl(session);
    let query: Awaited<ReturnType<HostedGeminiFilesClient["query"]>>;
    try {
      query = await this.provider.query(uploadUrl);
    } catch (error) {
      await this.uploads.reopenAfterIncomplete(principalSub, mediaId, now);
      throw error;
    }
    if (query.status !== "final" || query.offset !== session.declaredSizeBytes) {
      await this.uploads.reopenAfterIncomplete(principalSub, mediaId, now);
      throw new HostedMediaServiceError("hosted_media_upload_incomplete");
    }
    const name = query.geminiFileName ?? session.geminiFileName;
    if (!name) {
      await this.mismatch(session, uploadUrl);
      throw new HostedMediaServiceError("media_seal_mismatch");
    }
    let file: Awaited<ReturnType<HostedGeminiFilesClient["get"]>>;
    try {
      file = await this.provider.get(name);
    } catch (error) {
      await this.uploads.reopenAfterIncomplete(principalSub, mediaId, now);
      throw error;
    }
    if (
      file.sizeBytes !== session.declaredSizeBytes
      || file.mimeType !== session.mimeType
      || !file.sha256Hash
      || !remoteDigestMatchesHex(file.sha256Hash, session.declaredSha256)
    ) {
      await this.provider.deleteFile(name).catch(() => undefined);
      await this.uploads.abandon(principalSub, mediaId, new Date().toISOString());
      throw new HostedMediaServiceError("media_seal_mismatch");
    }
    const expiresAt = boundedExpiry(
      session.sessionExpiresAt,
      file.expirationTime,
    );
    return await this.uploads.seal({
      session,
      geminiFileName: name,
      geminiFileUri: file.uri,
      sealedAt: now,
      expiresAt,
    });
  }

  async cancel(principalSub: string, mediaId: string): Promise<void> {
    const now = new Date().toISOString();
    const session = await this.uploads.claimForCancel(principalSub, mediaId, now);
    try {
      if (session.uploadUrlCiphertext && session.uploadUrlIv) {
        await this.provider.abandon(
          await this.decryptSessionUrl(session),
          session.geminiFileName,
        );
      }
      await this.uploads.abandon(principalSub, mediaId, now);
    } catch (error) {
      await this.uploads.markCleanupFailed(
        principalSub,
        mediaId,
        new Date().toISOString(),
      );
      throw error;
    }
  }

  async sweep(principalSub: string): Promise<number> {
    const instant = new Date();
    const now = instant.toISOString();
    const staleSealBefore = new Date(
      instant.getTime() - STALE_SEAL_GRACE_MS,
    ).toISOString();
    const sessions = await this.uploads.expiredOpen(
      principalSub,
      now,
      staleSealBefore,
    );
    let deleted = 0;
    for (const candidate of sessions) {
      const session = await this.uploads.claimForExpiredCleanup(
        principalSub,
        candidate.mediaId,
        now,
        staleSealBefore,
      );
      if (!session) continue;
      try {
        if (session.uploadUrlCiphertext && session.uploadUrlIv) {
          await this.provider.abandon(
            await this.decryptSessionUrl(session),
            session.geminiFileName,
          );
        }
        await this.uploads.abandon(principalSub, session.mediaId, now);
        deleted += 1;
      } catch {
        await this.uploads.markCleanupFailed(principalSub, session.mediaId, now);
      }
    }
    return deleted;
  }

  private async mismatch(
    session: HostedMediaUploadSession,
    uploadUrl: string,
  ): Promise<void> {
    await this.provider.abandon(uploadUrl, session.geminiFileName)
      .catch(() => undefined);
    await this.uploads.abandon(
      session.principalSub,
      session.mediaId,
      new Date().toISOString(),
    );
  }

  private async decryptSessionUrl(
    session: HostedMediaUploadSession,
  ): Promise<string> {
    if (!session.uploadUrlCiphertext || !session.uploadUrlIv) {
      throw new HostedMediaServiceError("hosted_media_capability_missing");
    }
    return await decryptCapability(
      session.uploadUrlCiphertext,
      session.uploadUrlIv,
      this.apiKey,
      session.principalSub,
      session.mediaId,
    );
  }
}

async function capabilityKey(apiKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`frame-of-mind:hosted-media:v1:${apiKey}`),
  );
  return await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptCapability(
  value: string,
  apiKey: string,
  principalSub: string,
  mediaId: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: encoder.encode(`${principalSub}\n${mediaId}`),
  }, await capabilityKey(apiKey), encoder.encode(value));
  return {
    ciphertext: base64(new Uint8Array(ciphertext)),
    iv: base64(iv),
  };
}

async function decryptCapability(
  ciphertext: string,
  iv: string,
  apiKey: string,
  principalSub: string,
  mediaId: string,
): Promise<string> {
  try {
    const ivBytes = unbase64(iv);
    const ciphertextBytes = unbase64(ciphertext);
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: exactArrayBuffer(ivBytes),
      additionalData: encoder.encode(`${principalSub}\n${mediaId}`),
    }, await capabilityKey(apiKey), exactArrayBuffer(ciphertextBytes));
    return decoder.decode(plaintext);
  } catch {
    throw new HostedMediaServiceError("hosted_media_capability_unavailable");
  }
}

function base64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function remoteDigestMatchesHex(remote: string, expectedHex: string): boolean {
  const expected = expectedHex.toLowerCase();
  if (remote.toLowerCase() === expected) return true;
  try {
    const decoded = unbase64(remote);
    if (decoded.length === 32) return hex(decoded) === expected;
    const text = decoder.decode(decoded).trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(text) && text === expected;
  } catch {
    return false;
  }
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boundedExpiry(sessionExpiry: string, providerExpiry?: string): string {
  if (!providerExpiry || !Number.isFinite(Date.parse(providerExpiry))) {
    return sessionExpiry;
  }
  return Date.parse(providerExpiry) < Date.parse(sessionExpiry)
    ? new Date(providerExpiry).toISOString()
    : sessionExpiry;
}
