import type { SealedHostedMediaReceipt } from "./contracts.js";
import {
  hostedMediaUploadStateSchema,
  type HostedMediaCreateRequest,
  type HostedMediaUploadSession,
} from "./media.js";
import {
  HostedRepositoryError,
  type HostedD1Database,
} from "./repository.js";
import { opaqueIdSchema } from "../../../src/domain/studio-identifiers.js";

interface UploadRow {
  principal_sub: string;
  media_id: string;
  declared_size_bytes: number;
  declared_sha256: string;
  mime_type: HostedMediaCreateRequest["mimeType"];
  duration_seconds: number;
  retention: HostedMediaCreateRequest["retention"];
  upload_url_ciphertext: string | null;
  upload_url_iv: string | null;
  gemini_file_name: string | null;
  provider_part_bytes: number | null;
  r2_object_key: string | null;
  r2_upload_id: string | null;
  r2_capability_hash: string | null;
  r2_completed_at: string | null;
  state: HostedMediaUploadSession["state"];
  created_at: string;
  session_expires_at: string;
  updated_at: string;
}

export class HostedMediaRepository {
  constructor(private readonly database: HostedD1Database) {}

  async reserve(input: {
    principalSub: string;
    mediaId: string;
    declaration: HostedMediaCreateRequest;
    openSessionCap: number;
    createdAt: string;
    sessionExpiresAt: string;
  }): Promise<HostedMediaUploadSession> {
    await this.database.prepare(`
      INSERT INTO hosted_media_upload_sessions (
        principal_sub, media_id, declared_size_bytes, declared_sha256,
        mime_type, duration_seconds, retention, state, created_at,
        session_expires_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?
      WHERE (
        SELECT COUNT(*) FROM hosted_media_upload_sessions
        WHERE principal_sub = ?
          AND state IN ('creating', 'open', 'sealing', 'cleaning', 'cleanup_failed')
      ) < ?
    `).bind(
      input.principalSub,
      input.mediaId,
      input.declaration.declaredSizeBytes,
      input.declaration.declaredSha256,
      input.declaration.mimeType,
      input.declaration.durationSeconds,
      input.declaration.retention,
      input.createdAt,
      input.sessionExpiresAt,
      input.createdAt,
      input.principalSub,
      input.openSessionCap,
    ).run();
    const session = await this.get(input.principalSub, input.mediaId);
    if (!session) {
      throw new HostedRepositoryError("hosted_media_open_session_cap_exceeded");
    }
    return session;
  }

  async get(
    principalSub: string,
    mediaId: string,
  ): Promise<HostedMediaUploadSession | undefined> {
    const row = await this.database.prepare(`
      SELECT * FROM hosted_media_upload_sessions
      WHERE principal_sub = ? AND media_id = ?
    `).bind(principalSub, mediaId).first<UploadRow>();
    return row ? uploadFromRow(row) : undefined;
  }

  async listOpen(
    principalSub: string,
    now: string,
    limit = 100,
  ): Promise<HostedMediaUploadSession[]> {
    const result = await this.database.prepare(`
      SELECT * FROM hosted_media_upload_sessions
      WHERE principal_sub = ? AND state = 'open' AND session_expires_at > ?
      ORDER BY created_at ASC LIMIT ?
    `).bind(principalSub, now, limit).all<UploadRow>();
    return result.results.map(uploadFromRow);
  }

  async activate(input: {
    principalSub: string;
    mediaId: string;
    ciphertext: string;
    iv: string;
    providerPartBytes: number;
    geminiFileName?: string;
    r2ObjectKey?: string;
    r2UploadId?: string;
    r2CapabilityHash?: string;
    updatedAt: string;
  }): Promise<void> {
    await this.database.prepare(`
      UPDATE hosted_media_upload_sessions
      SET upload_url_ciphertext = ?, upload_url_iv = ?,
          provider_part_bytes = ?, gemini_file_name = ?, state = 'open',
          r2_object_key = ?, r2_upload_id = ?, r2_capability_hash = ?,
          updated_at = ?
      WHERE principal_sub = ? AND media_id = ? AND state = 'creating'
    `).bind(
      input.ciphertext,
      input.iv,
      input.providerPartBytes,
      input.geminiFileName ?? null,
      input.r2ObjectKey ?? null,
      input.r2UploadId ?? null,
      input.r2CapabilityHash ?? null,
      input.updatedAt,
      input.principalSub,
      input.mediaId,
    ).run();
    const session = await this.get(input.principalSub, input.mediaId);
    if (session?.state !== "open") {
      throw new HostedRepositoryError("hosted_media_session_activation_failed");
    }
  }

  async markRetainedComplete(
    principalSub: string,
    mediaId: string,
    capabilityHash: string,
    completedAt: string,
  ): Promise<void> {
    const result = await this.database.prepare(`
      UPDATE hosted_media_upload_sessions
      SET r2_completed_at = ?, r2_capability_hash = NULL, updated_at = ?
      WHERE principal_sub = ? AND media_id = ? AND state = 'open'
        AND r2_capability_hash = ? AND r2_completed_at IS NULL
    `).bind(completedAt, completedAt, principalSub, mediaId, capabilityHash).run();
    if (d1Changes(result) !== 1) {
      throw new HostedRepositoryError("hosted_retained_capability_unavailable");
    }
  }

  async claimForSeal(
    principalSub: string,
    mediaId: string,
    now: string,
  ): Promise<HostedMediaUploadSession> {
    const result = await this.database.prepare(`
      UPDATE hosted_media_upload_sessions SET state = 'sealing', updated_at = ?
      WHERE principal_sub = ? AND media_id = ? AND state = 'open'
        AND session_expires_at > ?
    `).bind(now, principalSub, mediaId, now).run();
    const session = await this.get(principalSub, mediaId);
    if (!session) throw new HostedRepositoryError("hosted_media_not_found");
    if (session.state === "sealed") return session;
    if (d1Changes(result) !== 1 || session.state !== "sealing") {
      throw new HostedRepositoryError(
        Date.parse(session.sessionExpiresAt) <= Date.parse(now)
          ? "hosted_media_session_expired"
          : "hosted_media_seal_conflict",
      );
    }
    return session;
  }

  async reopenAfterIncomplete(
    principalSub: string,
    mediaId: string,
    updatedAt: string,
  ): Promise<void> {
    await this.database.prepare(`
      UPDATE hosted_media_upload_sessions SET state = 'open', updated_at = ?
      WHERE principal_sub = ? AND media_id = ? AND state = 'sealing'
    `).bind(updatedAt, principalSub, mediaId).run();
  }

  async claimForCancel(
    principalSub: string,
    mediaId: string,
    now: string,
  ): Promise<HostedMediaUploadSession> {
    const result = await this.database.prepare(`
      UPDATE hosted_media_upload_sessions SET state = 'cleaning', updated_at = ?
      WHERE principal_sub = ? AND media_id = ?
        AND state IN ('creating', 'open', 'cleanup_failed')
    `).bind(now, principalSub, mediaId).run();
    const session = await this.get(principalSub, mediaId);
    if (!session) throw new HostedRepositoryError("hosted_media_not_found");
    if (session.state === "sealed") {
      throw new HostedRepositoryError("hosted_media_already_sealed");
    }
    if (d1Changes(result) !== 1 || session.state !== "cleaning") {
      throw new HostedRepositoryError("hosted_media_seal_conflict");
    }
    return session;
  }

  async claimForExpiredCleanup(
    principalSub: string,
    mediaId: string,
    now: string,
    staleSealBefore: string,
  ): Promise<HostedMediaUploadSession | undefined> {
    const result = await this.database.prepare(`
      UPDATE hosted_media_upload_sessions SET state = 'cleaning', updated_at = ?
      WHERE principal_sub = ? AND media_id = ? AND session_expires_at <= ?
        AND (
          state IN ('creating', 'open', 'cleanup_failed')
          OR (state IN ('sealing', 'cleaning') AND updated_at <= ?)
        )
    `).bind(now, principalSub, mediaId, now, staleSealBefore).run();
    if (d1Changes(result) !== 1) return undefined;
    return await this.get(principalSub, mediaId);
  }

  async seal(input: {
    session: HostedMediaUploadSession;
    geminiFileName: string;
    geminiFileUri: string;
    sealedAt: string;
    expiresAt: string;
    retainedUntil?: string;
  }): Promise<SealedHostedMediaReceipt> {
    const receipt: SealedHostedMediaReceipt = {
      principalSub: input.session.principalSub,
      mediaId: opaqueIdSchema.parse(input.session.mediaId),
      geminiFileName: input.geminiFileName,
      geminiFileUri: input.geminiFileUri,
      sha256: input.session.declaredSha256,
      sizeBytes: input.session.declaredSizeBytes,
      mimeType: input.session.mimeType,
      retention: input.session.retention,
      durationSeconds: input.session.durationSeconds,
      sealedAt: input.sealedAt,
      expiresAt: input.expiresAt,
      ...(input.session.r2ObjectKey
        ? { retainedObjectKey: input.session.r2ObjectKey }
        : {}),
      ...(input.retainedUntil ? { retainedUntil: input.retainedUntil } : {}),
    };
    await this.database.batch([
      this.database.prepare(`
        INSERT INTO hosted_media_receipts (
          principal_sub, media_id, gemini_file_name, gemini_file_uri,
          sha256, mime_type, retention, sealed_at, expires_at,
          duration_seconds, size_bytes, retained_object_key, retained_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        receipt.principalSub,
        receipt.mediaId,
        receipt.geminiFileName,
        receipt.geminiFileUri,
        receipt.sha256,
        receipt.mimeType,
        receipt.retention,
        receipt.sealedAt,
        receipt.expiresAt,
        receipt.durationSeconds,
        receipt.sizeBytes,
        receipt.retainedObjectKey ?? null,
        receipt.retainedUntil ?? null,
      ),
      this.database.prepare(`
        UPDATE hosted_media_upload_sessions
        SET state = 'sealed', gemini_file_name = ?, updated_at = ?
        WHERE principal_sub = ? AND media_id = ? AND state = 'sealing'
      `).bind(
        receipt.geminiFileName,
        receipt.sealedAt,
        receipt.principalSub,
        receipt.mediaId,
      ),
    ]);
    return receipt;
  }

  async abandon(
    principalSub: string,
    mediaId: string,
    updatedAt: string,
  ): Promise<void> {
    await this.database.prepare(`
      UPDATE hosted_media_upload_sessions
      SET state = 'abandoned', updated_at = ?
      WHERE principal_sub = ? AND media_id = ? AND state != 'sealed'
    `).bind(updatedAt, principalSub, mediaId).run();
  }

  async markCleanupFailed(
    principalSub: string,
    mediaId: string,
    updatedAt: string,
  ): Promise<void> {
    await this.database.prepare(`
      UPDATE hosted_media_upload_sessions
      SET state = 'cleanup_failed', updated_at = ?
      WHERE principal_sub = ? AND media_id = ? AND state != 'sealed'
    `).bind(updatedAt, principalSub, mediaId).run();
  }

  async expiredOpen(
    principalSub: string,
    now: string,
    staleSealBefore: string,
    limit = 100,
  ): Promise<HostedMediaUploadSession[]> {
    const result = await this.database.prepare(`
      SELECT * FROM hosted_media_upload_sessions
      WHERE principal_sub = ?
        AND (
          state IN ('creating', 'open', 'cleanup_failed')
          OR (state IN ('sealing', 'cleaning') AND updated_at <= ?)
        )
        AND session_expires_at <= ?
      ORDER BY session_expires_at ASC LIMIT ?
    `).bind(principalSub, staleSealBefore, now, limit).all<UploadRow>();
    return result.results.map(uploadFromRow);
  }
}

function d1Changes(result: unknown): number {
  if (!result || typeof result !== "object" || !("meta" in result)) return 0;
  const meta = result.meta;
  if (!meta || typeof meta !== "object" || !("changes" in meta)) return 0;
  return typeof meta.changes === "number" ? meta.changes : 0;
}

function uploadFromRow(row: UploadRow): HostedMediaUploadSession {
  return {
    principalSub: row.principal_sub,
    mediaId: row.media_id,
    declaredSizeBytes: row.declared_size_bytes,
    declaredSha256: row.declared_sha256,
    mimeType: row.mime_type,
    durationSeconds: row.duration_seconds,
    retention: row.retention,
    ...(row.upload_url_ciphertext
      ? { uploadUrlCiphertext: row.upload_url_ciphertext }
      : {}),
    ...(row.upload_url_iv ? { uploadUrlIv: row.upload_url_iv } : {}),
    ...(row.gemini_file_name ? { geminiFileName: row.gemini_file_name } : {}),
    ...(row.provider_part_bytes
      ? { providerPartBytes: row.provider_part_bytes }
      : {}),
    ...(row.r2_object_key ? { r2ObjectKey: row.r2_object_key } : {}),
    ...(row.r2_upload_id ? { r2UploadId: row.r2_upload_id } : {}),
    ...(row.r2_capability_hash
      ? { r2CapabilityHash: row.r2_capability_hash }
      : {}),
    ...(row.r2_completed_at ? { r2CompletedAt: row.r2_completed_at } : {}),
    state: hostedMediaUploadStateSchema.parse(row.state),
    createdAt: row.created_at,
    sessionExpiresAt: row.session_expires_at,
    updatedAt: row.updated_at,
  };
}
