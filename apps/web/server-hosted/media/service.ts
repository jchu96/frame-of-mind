import type { SealedHostedMediaReceipt } from "../../../workflows/src/contracts.js";
import { HostedMediaRepository } from "../../../workflows/src/media-repository.js";
import type {
  HostedMediaCreateRequest,
  HostedMediaCreateResponse,
  HostedMediaOpenSession,
  HostedMediaUploadSession,
} from "../../../workflows/src/media.js";
import { HostedWorkflowRepository } from "../../../workflows/src/repository.js";
import { HostedGeminiFilesClient } from "./provider.js";
import { opaqueIdSchema } from "../../../../src/domain/studio-identifiers.js";
import type { HostedD1Database } from "../../../workflows/src/repository.js";
import {
  digestR2Object,
  HostedMediaServiceError,
  type HostedR2Bucket,
  principalObjectPrefix,
  randomCapability,
  requireRetainedSession,
  sha256Hex,
  type HostedR2UploadedPart,
} from "./retention.js";

export { HostedMediaServiceError } from "./retention.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STALE_SEAL_GRACE_MS = 2 * 60_000;

export interface HostedRetainedPartReservation {
  principalSub: string;
  mediaId: string;
  partNumber: number;
  contentLength: number;
  r2ObjectKey: string;
  r2UploadId: string;
}

export class HostedMediaService {
  private readonly uploads: HostedMediaRepository;
  private readonly receipts: HostedWorkflowRepository;

  constructor(
    private readonly database: HostedD1Database,
    private readonly provider: HostedGeminiFilesClient,
    private readonly apiKey: string,
    private readonly bucket: HostedR2Bucket | undefined,
    private readonly origin: string,
    private readonly config: {
      openSessionCap: number;
      maxBytes: number;
      sessionTtlSeconds: number;
      retentionDays: number;
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
    let retained: { key: string; uploadId: string; capability: string } | undefined;
    try {
      if (declaration.retention === "retained") {
        if (!this.bucket) {
          throw new HostedMediaServiceError("hosted_retention_binding_unavailable");
        }
        const key = `${await principalObjectPrefix(principalSub)}/media/${crypto.randomUUID()}`;
        const multipart = await this.bucket.createMultipartUpload(key);
        retained = { key, uploadId: multipart.uploadId, capability: randomCapability() };
      }
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
        ...(retained
          ? {
              r2ObjectKey: retained.key,
              r2UploadId: retained.uploadId,
              r2CapabilityHash: await sha256Hex(retained.capability),
            }
          : {}),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const failedAt = new Date().toISOString();
      try {
        if (started) {
          await this.provider.abandon(
            started.uploadUrl,
            started.geminiFileName,
          );
        }
        if (retained && this.bucket) {
          await this.bucket.resumeMultipartUpload(retained.key, retained.uploadId)
            .abort().catch(() => undefined);
          await this.bucket.delete(retained.key).catch(() => undefined);
        }
        await this.uploads.abandon(principalSub, mediaId, failedAt);
      } catch {
        await this.uploads.markCleanupFailed(principalSub, mediaId, failedAt);
      }
      throw error;
    }
    const retainedBase = retained
      ? `${this.origin}/api/hosted/media/${encodeURIComponent(mediaId)}/retained`
      : undefined;
    return {
      mediaId: opaqueIdSchema.parse(mediaId),
      uploadUrl: started.uploadUrl,
      partBytes: started.partBytes,
      sessionExpiresAt,
      ...(retained && retainedBase
        ? {
            retainedUpload: {
              partUrl: `${retainedBase}/parts?cap=${retained.capability}`,
              completeUrl: `${retainedBase}/complete?cap=${retained.capability}`,
            },
          }
        : {}),
    };
  }

  async reserveRetainedPart(input: {
    principalSub: string;
    mediaId: string;
    capability: string;
    partNumber: number;
    contentLength: number;
  }): Promise<HostedRetainedPartReservation> {
    const now = new Date().toISOString();
    const session = await this.uploads.get(input.principalSub, input.mediaId);
    requireRetainedSession(session, now);
    const capabilityHash = await sha256Hex(input.capability);
    if (capabilityHash !== session.r2CapabilityHash) {
      throw new HostedMediaServiceError("hosted_retained_capability_unavailable");
    }
    if (!this.bucket) throw new HostedMediaServiceError("hosted_retention_binding_unavailable");
    if (
      !Number.isSafeInteger(input.contentLength)
      || input.contentLength < 1
      || input.contentLength > session.declaredSizeBytes
      || input.contentLength > this.config.maxBytes
    ) {
      throw new HostedMediaServiceError("hosted_retained_part_size_exceeded");
    }
    const reserved = await this.uploads.reserveRetainedPartBytes({
      principalSub: input.principalSub,
      mediaId: input.mediaId,
      capabilityHash,
      contentLength: input.contentLength,
      maxBytes: this.config.maxBytes,
      updatedAt: now,
    });
    if (!reserved) {
      const current = await this.uploads.get(input.principalSub, input.mediaId);
      requireRetainedSession(current, now);
      if (current.r2CapabilityHash !== capabilityHash) {
        throw new HostedMediaServiceError("hosted_retained_capability_unavailable");
      }
      throw new HostedMediaServiceError("hosted_retained_part_size_exceeded");
    }
    return {
      principalSub: input.principalSub,
      mediaId: input.mediaId,
      partNumber: input.partNumber,
      contentLength: input.contentLength,
      r2ObjectKey: session.r2ObjectKey,
      r2UploadId: session.r2UploadId,
    };
  }

  async uploadRetainedPart(
    reservation: HostedRetainedPartReservation,
    body: ReadableStream,
  ): Promise<HostedR2UploadedPart> {
    if (!this.bucket) throw new HostedMediaServiceError("hosted_retention_binding_unavailable");
    return await this.bucket.resumeMultipartUpload(
      reservation.r2ObjectKey,
      reservation.r2UploadId,
    ).uploadPart(reservation.partNumber, body);
  }

  async releaseRetainedPart(
    reservation: HostedRetainedPartReservation,
  ): Promise<void> {
    await this.uploads.releaseRetainedPartBytes({
      principalSub: reservation.principalSub,
      mediaId: reservation.mediaId,
      contentLength: reservation.contentLength,
      updatedAt: new Date().toISOString(),
    });
  }

  async completeRetainedUpload(input: {
    principalSub: string;
    mediaId: string;
    capability: string;
    parts: HostedR2UploadedPart[];
  }): Promise<void> {
    const now = new Date().toISOString();
    const session = await this.uploads.get(input.principalSub, input.mediaId);
    requireRetainedSession(session, now);
    const capabilityHash = await sha256Hex(input.capability);
    if (capabilityHash !== session.r2CapabilityHash) {
      throw new HostedMediaServiceError("hosted_retained_capability_unavailable");
    }
    if (!this.bucket) throw new HostedMediaServiceError("hosted_retention_binding_unavailable");
    await this.bucket.resumeMultipartUpload(session.r2ObjectKey, session.r2UploadId)
      .complete(input.parts);
    await this.uploads.markRetainedComplete(
      input.principalSub,
      input.mediaId,
      capabilityHash,
      now,
    );
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
    if (session.retention === "retained") {
      if (!this.bucket || !session.r2ObjectKey || !session.r2CompletedAt) {
        await this.mismatch(session, uploadUrl);
        throw new HostedMediaServiceError("hosted_retained_upload_incomplete");
      }
      const retainedObject = await this.bucket.get(session.r2ObjectKey);
      if (
        !retainedObject
        || retainedObject.size !== session.declaredSizeBytes
        || await digestR2Object(retainedObject) !== session.declaredSha256
      ) {
        await this.bucket.delete(session.r2ObjectKey).catch(() => undefined);
        await this.provider.deleteFile(name).catch(() => undefined);
        await this.uploads.abandon(principalSub, mediaId, new Date().toISOString());
        throw new HostedMediaServiceError("retained_media_seal_mismatch");
      }
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
      ...(session.retention === "retained"
        ? {
            retainedUntil: new Date(
              Date.parse(now) + this.config.retentionDays * 86_400_000,
            ).toISOString(),
          }
        : {}),
    });
  }

  async listOpen(principalSub: string): Promise<HostedMediaOpenSession[]> {
    const sessions = await this.uploads.listOpen(
      principalSub,
      new Date().toISOString(),
    );
    return await Promise.all(sessions.filter(
      (session) => session.retention === "ephemeral",
    ).map(async (session) => {
      if (!session.providerPartBytes) {
        throw new HostedMediaServiceError("hosted_media_capability_missing");
      }
      return {
        mediaId: opaqueIdSchema.parse(session.mediaId),
        uploadUrl: await this.decryptSessionUrl(session),
        partBytes: session.providerPartBytes,
        sessionExpiresAt: session.sessionExpiresAt,
        declaredSizeBytes: session.declaredSizeBytes,
        declaredSha256: session.declaredSha256,
        mimeType: session.mimeType,
        durationSeconds: session.durationSeconds,
        retention: session.retention,
      };
    }));
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
      await this.cleanupRetainedSession(session);
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

  async sweep(principalSub: string): Promise<{ abandoned: number; retained: number }> {
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
        await this.cleanupRetainedSession(session);
        await this.uploads.abandon(principalSub, session.mediaId, now);
        deleted += 1;
      } catch {
        await this.uploads.markCleanupFailed(principalSub, session.mediaId, now);
      }
    }
    let retained = 0;
    const expired = await this.database.prepare(`
      SELECT media_id, retained_object_key FROM hosted_media_receipts
      WHERE principal_sub = ? AND retained_object_key IS NOT NULL
        AND retained_deleted_at IS NULL
        AND (retained_delete_requested_at IS NOT NULL OR retained_until <= ?)
      LIMIT 100
    `).bind(principalSub, now).all<{ media_id: string; retained_object_key: string }>();
    for (const receipt of expired.results) {
      if (!this.bucket) break;
      await this.database.prepare(`
        UPDATE hosted_media_receipts
        SET retained_delete_requested_at = COALESCE(retained_delete_requested_at, ?)
        WHERE principal_sub = ? AND media_id = ? AND retained_deleted_at IS NULL
      `).bind(now, principalSub, receipt.media_id).run();
      try {
        await this.deleteRetainedObjects(
          principalSub,
          receipt.media_id,
          receipt.retained_object_key,
        );
      } catch {
        continue;
      }
      await this.database.prepare(`
        UPDATE hosted_media_receipts SET retained_deleted_at = ?
        WHERE principal_sub = ? AND media_id = ? AND retained_deleted_at IS NULL
      `).bind(now, principalSub, receipt.media_id).run();
      await this.database.prepare(`
        DELETE FROM hosted_evidence_captures
        WHERE principal_sub = ? AND media_id = ?
      `).bind(principalSub, receipt.media_id).run();
      retained += 1;
    }
    return { abandoned: deleted, retained };
  }

  async deleteRetained(principalSub: string, mediaId: string): Promise<void> {
    const receipt = await this.receipts.getMediaReceipt(principalSub, mediaId);
    if (!receipt?.retainedObjectKey || receipt.retainedDeleteRequestedAt || receipt.retainedDeletedAt) {
      throw new HostedMediaServiceError("hosted_media_not_found");
    }
    const active = await this.database.prepare(`
      SELECT 1 AS found FROM hosted_analysis_jobs job
      JOIN hosted_analysis_attempts attempt
        ON attempt.principal_sub = job.principal_sub AND attempt.job_id = job.job_id
      WHERE job.principal_sub = ? AND job.media_id = ?
        AND attempt.stage NOT IN ('succeeded','failed','canceled','indeterminate') LIMIT 1
    `).bind(principalSub, mediaId).first<{ found: number }>();
    if (active) throw new HostedMediaServiceError("hosted_retained_media_in_use");
    if (!this.bucket) throw new HostedMediaServiceError("hosted_retention_binding_unavailable");
    const requestedAt = new Date().toISOString();
    const claim = await this.database.prepare(`
      UPDATE hosted_media_receipts SET retained_delete_requested_at = ?
      WHERE principal_sub = ? AND media_id = ?
        AND retained_delete_requested_at IS NULL AND retained_deleted_at IS NULL
    `).bind(requestedAt, principalSub, mediaId).run();
    if (d1Changes(claim) !== 1) {
      throw new HostedMediaServiceError("hosted_media_not_found");
    }
    await this.deleteRetainedObjects(principalSub, mediaId, receipt.retainedObjectKey);
    await this.database.prepare(`
      UPDATE hosted_media_receipts SET retained_deleted_at = ?
      WHERE principal_sub = ? AND media_id = ? AND retained_deleted_at IS NULL
    `).bind(new Date().toISOString(), principalSub, mediaId).run();
    await this.database.prepare(`
      DELETE FROM hosted_evidence_captures
      WHERE principal_sub = ? AND media_id = ?
    `).bind(principalSub, mediaId).run();
  }

  private async mismatch(
    session: HostedMediaUploadSession,
    uploadUrl: string,
  ): Promise<void> {
    await this.provider.abandon(uploadUrl, session.geminiFileName)
      .catch(() => undefined);
    await this.cleanupRetainedSession(session);
    await this.uploads.abandon(
      session.principalSub,
      session.mediaId,
      new Date().toISOString(),
    );
  }

  private async cleanupRetainedSession(session: HostedMediaUploadSession): Promise<void> {
    if (!this.bucket || !session.r2ObjectKey) return;
    if (session.r2UploadId && !session.r2CompletedAt) {
      await this.bucket.resumeMultipartUpload(session.r2ObjectKey, session.r2UploadId)
        .abort().catch(() => undefined);
    }
    await this.bucket.delete(session.r2ObjectKey).catch(() => undefined);
  }

  private async deleteRetainedObjects(
    principalSub: string,
    mediaId: string,
    mediaObjectKey: string,
  ): Promise<void> {
    if (!this.bucket) throw new HostedMediaServiceError("hosted_retention_binding_unavailable");
    const captures = await this.database.prepare(`
      SELECT object_key FROM hosted_evidence_captures
      WHERE principal_sub = ? AND media_id = ? LIMIT 500
    `).bind(principalSub, mediaId).all<{ object_key: string }>();
    await this.bucket.delete([
      mediaObjectKey,
      ...captures.results.map((capture) => capture.object_key),
    ]);
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

function d1Changes(result: unknown): number {
  if (!result || typeof result !== "object" || !("meta" in result)) return 0;
  const meta = result.meta;
  return meta && typeof meta === "object" && "changes" in meta
    && typeof meta.changes === "number" ? meta.changes : 0;
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
