import type { HostedD1Database } from "../../../workflows/src/repository.js";
import type { HostedR2Bucket, HostedR2Object } from "../media/retention.js";
import { principalObjectPrefix, sha256Hex } from "../media/retention.js";

const MAX_CAPTURE_BYTES = 8 * 1_024 * 1_024;

export interface HostedStreamThumbnailAdapter {
  readonly enabled: boolean;
  capture(input: { principalSub: string; runId: string; timestampSeconds: number }): Promise<Uint8Array>;
}

export interface HostedEvidenceView {
  id: string;
  runId: string;
  timestampSeconds: number;
  capturedAt: string;
  captureSha256: string;
  mimeType: "image/png";
  source: { manifestSha256: string; recordingSha256: string };
}

export class HostedEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostedEvidenceError";
  }
}

interface ContextRow {
  media_id: string;
  sha256: string;
  mime_type: string;
  retained_object_key: string | null;
  retained_until: string | null;
  retained_delete_requested_at: string | null;
  retained_deleted_at: string | null;
  duration_seconds: number;
  manifest_json: string | null;
}

interface CaptureRow {
  evidence_id: string;
  run_id: string;
  source_manifest_sha256: string;
  source_recording_sha256: string;
  timestamp_seconds: number;
  captured_at: string;
  capture_sha256: string;
  mime_type: "image/png";
}

export class HostedEvidenceService {
  constructor(
    private readonly database: HostedD1Database,
    private readonly bucket: HostedR2Bucket,
  ) {}

  async source(principalSub: string, runId: string): Promise<{
    manifestSha256: string;
    recordingSha256: string;
    mediaId: string;
    mimeType: string;
    keptUntil: string;
    durationSeconds: number;
  }> {
    const context = await this.context(principalSub, runId);
    if (
      !context.retained_object_key
      || context.retained_deleted_at
      || context.retained_delete_requested_at
      || !context.retained_until
      || Date.parse(context.retained_until) <= Date.now()
    ) throw new HostedEvidenceError("hosted_capture_media_unavailable");
    if (!context.manifest_json) throw new HostedEvidenceError("hosted_capture_manifest_unavailable");
    const manifest = JSON.parse(context.manifest_json) as { recordingSha256?: unknown };
    if (manifest.recordingSha256 !== context.sha256) {
      throw new HostedEvidenceError("hosted_capture_recording_provenance_mismatch");
    }
    return {
      manifestSha256: await sha256Hex(context.manifest_json),
      recordingSha256: context.sha256,
      mediaId: context.media_id,
      mimeType: context.mime_type,
      keptUntil: context.retained_until,
      durationSeconds: context.duration_seconds,
    };
  }

  async openMedia(
    principalSub: string,
    runId: string,
    range?: { start: number; end: number },
  ): Promise<{ object: HostedR2Object; mimeType: string; total: number }> {
    const context = await this.context(principalSub, runId);
    if (
      !context.retained_object_key
      || context.retained_deleted_at
      || context.retained_delete_requested_at
      || !context.retained_until
      || Date.parse(context.retained_until) <= Date.now()
    ) throw new HostedEvidenceError("hosted_capture_media_unavailable");
    const head = await this.bucket.head(context.retained_object_key);
    if (!head) throw new HostedEvidenceError("hosted_capture_media_unavailable");
    const object = await this.bucket.get(
      context.retained_object_key,
      range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
    );
    if (!object) throw new HostedEvidenceError("hosted_capture_media_unavailable");
    return { object, mimeType: context.mime_type, total: head.size };
  }

  async mediaInfo(principalSub: string, runId: string): Promise<{
    total: number;
    mimeType: string;
    recordingSha256: string;
  }> {
    const source = await this.source(principalSub, runId);
    const context = await this.context(principalSub, runId);
    const head = context.retained_object_key
      ? await this.bucket.head(context.retained_object_key)
      : null;
    if (!head) throw new HostedEvidenceError("hosted_capture_media_unavailable");
    return { total: head.size, mimeType: context.mime_type, recordingSha256: source.recordingSha256 };
  }

  async list(principalSub: string, runId: string): Promise<{
    source: Awaited<ReturnType<HostedEvidenceService["source"]>>;
    evidence: HostedEvidenceView[];
  }> {
    const source = await this.source(principalSub, runId);
    const rows = await this.database.prepare(`
      SELECT * FROM hosted_evidence_captures
      WHERE principal_sub = ? AND run_id = ?
      ORDER BY captured_at ASC, evidence_id ASC
    `).bind(principalSub, runId).all<CaptureRow>();
    return { source, evidence: rows.results.map(captureView) };
  }

  async capture(input: {
    principalSub: string;
    runId: string;
    timestampSeconds: number;
    sourceManifestSha256: string;
    sourceRecordingSha256: string;
    bytes: Uint8Array;
  }): Promise<HostedEvidenceView> {
    if (!Number.isFinite(input.timestampSeconds) || input.timestampSeconds < 0 || input.timestampSeconds > 86_400) {
      throw new HostedEvidenceError("hosted_capture_timestamp_invalid");
    }
    if (input.bytes.byteLength < 8 || input.bytes.byteLength > MAX_CAPTURE_BYTES) {
      throw new HostedEvidenceError("hosted_capture_size_invalid");
    }
    if (!isPng(input.bytes)) throw new HostedEvidenceError("hosted_capture_format_invalid");
    const source = await this.source(input.principalSub, input.runId);
    const timestampSeconds = Math.min(input.timestampSeconds, source.durationSeconds);
    if (
      input.sourceManifestSha256 !== source.manifestSha256
      || input.sourceRecordingSha256 !== source.recordingSha256
    ) throw new HostedEvidenceError("hosted_capture_provenance_invalid");
    const evidenceId = `evidence_${crypto.randomUUID().replaceAll("-", "")}`;
    const capturedAt = new Date().toISOString();
    const captureSha256 = await sha256Hex(input.bytes);
    const objectKey = `${await principalObjectPrefix(input.principalSub)}/evidence/${crypto.randomUUID()}.png`;
    await this.bucket.put(objectKey, input.bytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { runId: input.runId, evidenceId },
    });
    try {
      const inserted = await this.database.prepare(`
        INSERT INTO hosted_evidence_captures (
          principal_sub, evidence_id, run_id, media_id,
          source_manifest_sha256, source_recording_sha256, timestamp_seconds,
          captured_at, capture_sha256, mime_type, object_key
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/png', ?
        WHERE EXISTS (
          SELECT 1 FROM hosted_media_receipts
          WHERE principal_sub = ? AND media_id = ?
            AND retained_delete_requested_at IS NULL
            AND retained_deleted_at IS NULL AND retained_until > ?
        )
        AND (
          SELECT COUNT(*) FROM hosted_evidence_captures
          WHERE principal_sub = ? AND run_id = ?
        ) < 500
      `).bind(
        input.principalSub, evidenceId, input.runId, source.mediaId,
        source.manifestSha256, source.recordingSha256, timestampSeconds,
        capturedAt, captureSha256, objectKey,
        input.principalSub, source.mediaId, capturedAt,
        input.principalSub, input.runId,
      ).run();
      if (d1Changes(inserted) !== 1) {
        throw new HostedEvidenceError("hosted_capture_media_unavailable");
      }
    } catch (error) {
      await this.bucket.delete(objectKey).catch(() => undefined);
      throw error;
    }
    return {
      id: evidenceId,
      runId: input.runId,
      timestampSeconds,
      capturedAt,
      captureSha256,
      mimeType: "image/png",
      source: {
        manifestSha256: source.manifestSha256,
        recordingSha256: source.recordingSha256,
      },
    };
  }

  private async context(principalSub: string, runId: string): Promise<ContextRow> {
    const row = await this.database.prepare(`
      SELECT media.media_id, media.sha256, media.mime_type,
        media.retained_object_key, media.retained_until, media.retained_deleted_at,
        media.retained_delete_requested_at, media.duration_seconds,
        COALESCE(meeting.manifest_json, video.manifest_json) AS manifest_json
      FROM hosted_analysis_attempts attempt
      JOIN hosted_analysis_jobs job
        ON job.principal_sub = attempt.principal_sub AND job.job_id = attempt.job_id
      JOIN hosted_media_receipts media
        ON media.principal_sub = job.principal_sub AND media.media_id = job.media_id
      LEFT JOIN analysis_runs meeting
        ON meeting.principal_sub = attempt.principal_sub AND meeting.run_id = attempt.run_id
      LEFT JOIN video_analysis_runs video
        ON video.principal_sub = attempt.principal_sub AND video.run_id = attempt.run_id
      WHERE attempt.principal_sub = ? AND attempt.run_id = ? AND attempt.stage = 'succeeded'
      LIMIT 1
    `).bind(principalSub, runId).first<ContextRow>();
    if (!row) throw new HostedEvidenceError("hosted_capture_run_not_found");
    return row;
  }
}

function captureView(row: CaptureRow): HostedEvidenceView {
  return {
    id: row.evidence_id,
    runId: row.run_id,
    timestampSeconds: row.timestamp_seconds,
    capturedAt: row.captured_at,
    captureSha256: row.capture_sha256,
    mimeType: row.mime_type,
    source: {
      manifestSha256: row.source_manifest_sha256,
      recordingSha256: row.source_recording_sha256,
    },
  };
}

function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
    && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a
    && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

function d1Changes(result: unknown): number {
  if (!result || typeof result !== "object" || !("meta" in result)) return 0;
  const meta = result.meta;
  return meta && typeof meta === "object" && "changes" in meta
    && typeof meta.changes === "number" ? meta.changes : 0;
}
