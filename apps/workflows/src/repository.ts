import { createHash } from "node:crypto";
import {
  hostedAttemptInputSchema,
  hostedAttemptSchema,
  sealedHostedMediaReceiptSchema,
  type HostedAnalysisAttempt,
  type HostedAttemptInput,
  type SealedHostedMediaReceipt,
} from "./contracts.js";

const MAX_RECEIPT_JSON_BYTES = 32 * 1_024;

export class HostedRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostedRepositoryError";
  }
}

interface AttemptRow {
  principal_sub: string;
  attempt_id: string;
  job_id: string;
  retry_of_attempt_id: string | null;
  attempt_number: number;
  idempotency_key: string;
  workflow_instance_id: string;
  immutable_input_json: string;
  stage: HostedAnalysisAttempt["stage"];
  spend_reserved_units: number;
  cancellation_requested_at: string | null;
  run_id: string | null;
  error_code: string | null;
  cleanup_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MediaRow {
  principal_sub: string;
  media_id: string;
  gemini_file_name: string;
  gemini_file_uri: string;
  sha256: string;
  mime_type: string;
  retention: "ephemeral" | "retained";
  sealed_at: string;
  expires_at: string;
}

export interface HostedAttemptCreateResult {
  attempt: HostedAnalysisAttempt;
  replayed: boolean;
}

export interface HostedEventView {
  sequence: number;
  stage: string;
  kind: string;
  code?: string;
  occurredAt: string;
}

export interface HostedD1PreparedStatement {
  bind(...values: unknown[]): HostedD1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface HostedD1Database {
  prepare(query: string): HostedD1PreparedStatement;
  batch(statements: HostedD1PreparedStatement[]): Promise<unknown>;
}

export class HostedWorkflowRepository {
  constructor(private readonly database: HostedD1Database) {}

  async getMediaReceipt(
    principalSub: string,
    mediaId: string,
  ): Promise<SealedHostedMediaReceipt | undefined> {
    const row = await this.database.prepare(`
      SELECT * FROM hosted_media_receipts
      WHERE principal_sub = ? AND media_id = ?
    `).bind(principalSub, mediaId).first<MediaRow>();
    return row ? mediaFromRow(row) : undefined;
  }

  async requireUsableMediaReceipt(
    principalSub: string,
    mediaId: string,
    now: string,
  ): Promise<SealedHostedMediaReceipt> {
    const receipt = await this.getMediaReceipt(principalSub, mediaId);
    if (!receipt) throw new HostedRepositoryError("sealed_media_receipt_missing");
    if (Date.parse(receipt.expiresAt) <= Date.parse(now)) {
      throw new HostedRepositoryError("sealed_media_receipt_expired");
    }
    return receipt;
  }

  async createInitialAttempt(input: {
    principalSub: string;
    principalEmail?: string;
    idempotencyKey: string;
    immutableInput: HostedAttemptInput;
    reserveUnits: number;
    createdAt: string;
    jobId: string;
    attemptId: string;
    workflowInstanceId: string;
  }): Promise<HostedAttemptCreateResult> {
    const immutableInput = hostedAttemptInputSchema.parse(input.immutableInput);
    const immutableJson = JSON.stringify(immutableInput);
    const replay = await this.getByIdempotencyKey(
      input.principalSub,
      input.idempotencyKey,
    );
    if (replay) return assertReplay(replay, immutableJson, true);

    const availabilitySql = `
      EXISTS (
        SELECT 1 FROM hosted_media_receipts media
        WHERE media.principal_sub = ? AND media.media_id = ?
          AND media.sha256 = ? AND media.expires_at > ?
      )
      AND EXISTS (
        SELECT 1 FROM hosted_principal_spend spend
        WHERE spend.principal_sub = ?
          AND spend.committed_units + COALESCE((
            SELECT SUM(reserved_units) FROM hosted_spend_reservations active
            WHERE active.principal_sub = spend.principal_sub
              AND active.state = 'reserved'
          ), 0) + ? <= spend.cap_units
      )`;
    const statements = [
      this.database.prepare(`
        INSERT OR IGNORE INTO hosted_analysis_jobs (
          principal_sub, job_id, principal_email, media_id, created_at
        )
        SELECT ?, ?, ?, ?, ?
        WHERE ${availabilitySql}
          AND NOT EXISTS (
            SELECT 1 FROM hosted_analysis_attempts existing
            WHERE existing.principal_sub = ? AND existing.idempotency_key = ?
          )
      `).bind(
        input.principalSub,
        input.jobId,
        input.principalEmail ?? null,
        immutableInput.mediaId,
        input.createdAt,
        input.principalSub,
        immutableInput.mediaId,
        immutableInput.mediaSha256,
        input.createdAt,
        input.principalSub,
        input.reserveUnits,
        input.principalSub,
        input.idempotencyKey,
      ),
      this.database.prepare(`
        INSERT OR IGNORE INTO hosted_analysis_attempts (
          principal_sub, attempt_id, job_id, retry_of_attempt_id,
          attempt_number, idempotency_key, workflow_instance_id,
          immutable_input_json, stage, spend_reserved_units, created_at,
          updated_at
        )
        SELECT ?, ?, ?, NULL, 1, ?, ?, ?, 'queued', ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM hosted_analysis_jobs
          WHERE principal_sub = ? AND job_id = ?
        )
      `).bind(
        input.principalSub,
        input.attemptId,
        input.jobId,
        input.idempotencyKey,
        input.workflowInstanceId,
        immutableJson,
        input.reserveUnits,
        input.createdAt,
        input.createdAt,
        input.principalSub,
        input.jobId,
      ),
      this.database.prepare(`
        INSERT OR IGNORE INTO hosted_spend_reservations (
          principal_sub, attempt_id, reserved_units, state, created_at,
          updated_at
        )
        SELECT ?, ?, ?, 'reserved', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM hosted_analysis_attempts
          WHERE principal_sub = ? AND attempt_id = ?
            AND idempotency_key = ?
        )
      `).bind(
        input.principalSub,
        input.attemptId,
        input.reserveUnits,
        input.createdAt,
        input.createdAt,
        input.principalSub,
        input.attemptId,
        input.idempotencyKey,
      ),
    ];
    await this.database.batch(statements);
    const created = await this.getByIdempotencyKey(
      input.principalSub,
      input.idempotencyKey,
    );
    if (created) return assertReplay(created, immutableJson, input.attemptId);
    await this.explainCreateFailure(
      input.principalSub,
      immutableInput.mediaId,
      input.reserveUnits,
      input.createdAt,
    );
    throw new HostedRepositoryError("hosted_attempt_create_failed");
  }

  async createLinkedRetry(input: {
    principalSub: string;
    parentAttemptId: string;
    idempotencyKey: string;
    reserveUnits: number;
    createdAt: string;
    attemptId: string;
    workflowInstanceId: string;
  }): Promise<HostedAttemptCreateResult> {
    const existing = await this.getByIdempotencyKey(
      input.principalSub,
      input.idempotencyKey,
    );
    if (existing) return { attempt: existing, replayed: true };
    const parent = await this.getAttempt(
      input.principalSub,
      input.parentAttemptId,
    );
    if (!parent) throw new HostedRepositoryError("hosted_attempt_not_found");
    if (!isRetryableStage(parent.stage)) {
      throw new HostedRepositoryError("hosted_attempt_not_retryable");
    }
    const media = await this.requireUsableMediaReceipt(
      input.principalSub,
      parent.input.mediaId,
      input.createdAt,
    );
    if (media.sha256 !== parent.input.mediaSha256) {
      throw new HostedRepositoryError("sealed_media_receipt_mismatch");
    }
    const immutableJson = JSON.stringify(parent.input);
    await this.database.batch([
      this.database.prepare(`
        INSERT OR IGNORE INTO hosted_analysis_attempts (
          principal_sub, attempt_id, job_id, retry_of_attempt_id,
          attempt_number, idempotency_key, workflow_instance_id,
          immutable_input_json, stage, spend_reserved_units, created_at,
          updated_at
        )
        SELECT ?, ?, parent.job_id, parent.attempt_id,
          COALESCE((
            SELECT MAX(attempt_number) + 1 FROM hosted_analysis_attempts siblings
            WHERE siblings.principal_sub = parent.principal_sub
              AND siblings.job_id = parent.job_id
          ), parent.attempt_number + 1),
          ?, ?, parent.immutable_input_json, 'queued', ?, ?, ?
        FROM hosted_analysis_attempts parent
        WHERE parent.principal_sub = ? AND parent.attempt_id = ?
          AND parent.stage IN ('failed', 'canceled', 'indeterminate')
          AND EXISTS (
            SELECT 1 FROM hosted_media_receipts media
            WHERE media.principal_sub = parent.principal_sub
              AND media.media_id = json_extract(parent.immutable_input_json, '$.mediaId')
              AND media.sha256 = json_extract(parent.immutable_input_json, '$.mediaSha256')
              AND media.expires_at > ?
          )
          AND EXISTS (
            SELECT 1 FROM hosted_principal_spend spend
            WHERE spend.principal_sub = parent.principal_sub
              AND spend.committed_units + COALESCE((
                SELECT SUM(reserved_units) FROM hosted_spend_reservations active
                WHERE active.principal_sub = spend.principal_sub
                  AND active.state = 'reserved'
              ), 0) + ? <= spend.cap_units
          )
      `).bind(
        input.principalSub,
        input.attemptId,
        input.idempotencyKey,
        input.workflowInstanceId,
        input.reserveUnits,
        input.createdAt,
        input.createdAt,
        input.principalSub,
        input.parentAttemptId,
        input.createdAt,
        input.reserveUnits,
      ),
      this.database.prepare(`
        INSERT OR IGNORE INTO hosted_spend_reservations (
          principal_sub, attempt_id, reserved_units, state, created_at,
          updated_at
        )
        SELECT ?, ?, ?, 'reserved', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM hosted_analysis_attempts
          WHERE principal_sub = ? AND attempt_id = ?
            AND idempotency_key = ?
        )
      `).bind(
        input.principalSub,
        input.attemptId,
        input.reserveUnits,
        input.createdAt,
        input.createdAt,
        input.principalSub,
        input.attemptId,
        input.idempotencyKey,
      ),
    ]);
    const created = await this.getByIdempotencyKey(
      input.principalSub,
      input.idempotencyKey,
    );
    if (created) return assertReplay(created, immutableJson, input.attemptId);
    await this.explainCreateFailure(
      input.principalSub,
      parent.input.mediaId,
      input.reserveUnits,
      input.createdAt,
    );
    throw new HostedRepositoryError("hosted_retry_create_failed");
  }

  async getAttempt(
    principalSub: string,
    attemptId: string,
  ): Promise<HostedAnalysisAttempt | undefined> {
    const row = await this.database.prepare(`
      SELECT * FROM hosted_analysis_attempts
      WHERE principal_sub = ? AND attempt_id = ?
    `).bind(principalSub, attemptId).first<AttemptRow>();
    return row ? attemptFromRow(row) : undefined;
  }

  async getByIdempotencyKey(
    principalSub: string,
    idempotencyKey: string,
  ): Promise<HostedAnalysisAttempt | undefined> {
    const row = await this.database.prepare(`
      SELECT * FROM hosted_analysis_attempts
      WHERE principal_sub = ? AND idempotency_key = ?
    `).bind(principalSub, idempotencyKey).first<AttemptRow>();
    return row ? attemptFromRow(row) : undefined;
  }

  async setStage(
    principalSub: string,
    attemptId: string,
    stage: HostedAnalysisAttempt["stage"],
    occurredAt: string,
  ): Promise<void> {
    await this.database.prepare(`
      UPDATE hosted_analysis_attempts
      SET stage = ?, updated_at = ?
      WHERE principal_sub = ? AND attempt_id = ?
        AND stage NOT IN ('succeeded', 'failed', 'canceled', 'indeterminate')
    `).bind(stage, occurredAt, principalSub, attemptId).run();
  }

  async requestCancellation(
    principalSub: string,
    attemptId: string,
    occurredAt: string,
  ): Promise<HostedAnalysisAttempt | undefined> {
    await this.database.batch([
      this.database.prepare(`
        UPDATE hosted_analysis_attempts
        SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
            updated_at = ?
        WHERE principal_sub = ? AND attempt_id = ?
          AND stage NOT IN ('succeeded', 'failed', 'canceled', 'indeterminate')
      `).bind(occurredAt, occurredAt, principalSub, attemptId),
      eventStatement(
        this.database,
        principalSub,
        attemptId,
        "cancel_requested",
        "operator_canceled",
        occurredAt,
      ),
    ]);
    return await this.getAttempt(principalSub, attemptId);
  }

  async assertNotCanceled(
    principalSub: string,
    attemptId: string,
  ): Promise<void> {
    const attempt = await this.getAttempt(principalSub, attemptId);
    if (!attempt) throw new HostedRepositoryError("hosted_attempt_not_found");
    if (attempt.cancellationRequestedAt) {
      throw new HostedRepositoryError("operator_canceled");
    }
  }

  async getReceipt(
    principalSub: string,
    attemptId: string,
    stepName: string,
  ): Promise<{ json: string; sha256: string } | undefined> {
    return await this.database.prepare(`
      SELECT receipt_json AS json, receipt_sha256 AS sha256
      FROM hosted_analysis_receipts
      WHERE principal_sub = ? AND attempt_id = ? AND step_name = ?
    `).bind(principalSub, attemptId, stepName).first<{
      json: string;
      sha256: string;
    }>() ?? undefined;
  }

  async putReceipt(
    principalSub: string,
    attemptId: string,
    stepName: string,
    value: unknown,
    occurredAt: string,
  ): Promise<{ json: string; sha256: string }> {
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).byteLength > MAX_RECEIPT_JSON_BYTES) {
      throw new HostedRepositoryError("workflow_receipt_too_large");
    }
    const sha256 = createHash("sha256").update(json).digest("hex");
    await this.database.prepare(`
      INSERT OR IGNORE INTO hosted_analysis_receipts (
        principal_sub, attempt_id, step_name, receipt_json,
        receipt_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      principalSub,
      attemptId,
      stepName,
      json,
      sha256,
      occurredAt,
    ).run();
    const stored = await this.getReceipt(principalSub, attemptId, stepName);
    if (!stored || stored.sha256 !== sha256 || stored.json !== json) {
      throw new HostedRepositoryError("workflow_receipt_conflict");
    }
    return stored;
  }

  async appendEvent(
    principalSub: string,
    attemptId: string,
    kind: string,
    code: string | undefined,
    occurredAt: string,
  ): Promise<void> {
    await eventStatement(
      this.database,
      principalSub,
      attemptId,
      kind,
      code,
      occurredAt,
    ).run();
  }

  async events(
    principalSub: string,
    attemptId: string,
    limit = 100,
  ): Promise<HostedEventView[]> {
    const result = await this.database.prepare(`
      SELECT sequence, stage, event_kind, code, occurred_at
      FROM hosted_analysis_events
      WHERE principal_sub = ? AND attempt_id = ?
      ORDER BY sequence ASC LIMIT ?
    `).bind(principalSub, attemptId, Math.min(100, Math.max(1, limit))).all<{
      sequence: number;
      stage: string;
      event_kind: string;
      code: string | null;
      occurred_at: string;
    }>();
    return result.results.map((event) => ({
      sequence: event.sequence,
      stage: event.stage,
      kind: event.event_kind,
      ...(event.code ? { code: event.code } : {}),
      occurredAt: event.occurred_at,
    }));
  }

  async finishAttempt(input: {
    principalSub: string;
    attemptId: string;
    stage: "succeeded" | "failed" | "canceled" | "indeterminate";
    occurredAt: string;
    runId?: string;
    errorCode?: string;
    cleanupCompleted: boolean;
  }): Promise<void> {
    const successful = input.stage === "succeeded";
    await this.database.batch([
      ...(successful
        ? [this.database.prepare(`
            UPDATE hosted_principal_spend
            SET committed_units = committed_units + COALESCE((
              SELECT reserved_units FROM hosted_spend_reservations
              WHERE principal_sub = ? AND attempt_id = ? AND state = 'reserved'
            ), 0), updated_at = ?
            WHERE principal_sub = ?
          `).bind(
            input.principalSub,
            input.attemptId,
            input.occurredAt,
            input.principalSub,
          )]
        : []),
      this.database.prepare(`
        UPDATE hosted_spend_reservations
        SET state = ?, updated_at = ?
        WHERE principal_sub = ? AND attempt_id = ? AND state = 'reserved'
      `).bind(
        successful ? "committed" : "released",
        input.occurredAt,
        input.principalSub,
        input.attemptId,
      ),
      this.database.prepare(`
        UPDATE hosted_analysis_attempts
        SET stage = ?, run_id = ?, error_code = ?,
            cleanup_completed_at = ?, updated_at = ?
        WHERE principal_sub = ? AND attempt_id = ?
          AND stage NOT IN ('succeeded', 'failed', 'canceled', 'indeterminate')
      `).bind(
        input.stage,
        input.runId ?? null,
        input.errorCode ?? null,
        input.cleanupCompleted ? input.occurredAt : null,
        input.occurredAt,
        input.principalSub,
        input.attemptId,
      ),
    ]);
  }

  private async explainCreateFailure(
    principalSub: string,
    mediaId: string,
    reserveUnits: number,
    now: string,
  ): Promise<never> {
    await this.requireUsableMediaReceipt(principalSub, mediaId, now);
    const spend = await this.database.prepare(`
      SELECT cap_units, committed_units, COALESCE((
        SELECT SUM(reserved_units) FROM hosted_spend_reservations active
        WHERE active.principal_sub = spend.principal_sub
          AND active.state = 'reserved'
      ), 0) AS reserved_units
      FROM hosted_principal_spend spend WHERE principal_sub = ?
    `).bind(principalSub).first<{
      cap_units: number;
      committed_units: number;
      reserved_units: number;
    }>();
    if (!spend) throw new HostedRepositoryError("principal_spend_cap_unavailable");
    if (spend.committed_units + spend.reserved_units + reserveUnits > spend.cap_units) {
      throw new HostedRepositoryError("principal_spend_cap_exceeded");
    }
    throw new HostedRepositoryError("hosted_attempt_create_conflict");
  }
}

function eventStatement(
  database: HostedD1Database,
  principalSub: string,
  attemptId: string,
  kind: string,
  code: string | undefined,
  occurredAt: string,
): HostedD1PreparedStatement {
  return database.prepare(`
    INSERT INTO hosted_analysis_events (
      principal_sub, attempt_id, sequence, stage, event_kind, code, occurred_at
    )
    SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1,
      COALESCE((
        SELECT stage FROM hosted_analysis_attempts
        WHERE principal_sub = ? AND attempt_id = ?
      ), 'failed'), ?, ?, ?
    FROM hosted_analysis_events
    WHERE principal_sub = ? AND attempt_id = ?
  `).bind(
    principalSub,
    attemptId,
    principalSub,
    attemptId,
    kind,
    code ?? null,
    occurredAt,
    principalSub,
    attemptId,
  );
}

function attemptFromRow(row: AttemptRow): HostedAnalysisAttempt {
  return hostedAttemptSchema.parse({
    principalSub: row.principal_sub,
    attemptId: row.attempt_id,
    jobId: row.job_id,
    ...(row.retry_of_attempt_id
      ? { retryOfAttemptId: row.retry_of_attempt_id }
      : {}),
    attemptNumber: row.attempt_number,
    idempotencyKey: row.idempotency_key,
    workflowInstanceId: row.workflow_instance_id,
    input: JSON.parse(row.immutable_input_json),
    stage: row.stage,
    spendReservedUnits: row.spend_reserved_units,
    ...(row.cancellation_requested_at
      ? { cancellationRequestedAt: row.cancellation_requested_at }
      : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.cleanup_completed_at
      ? { cleanupCompletedAt: row.cleanup_completed_at }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mediaFromRow(row: MediaRow): SealedHostedMediaReceipt {
  return sealedHostedMediaReceiptSchema.parse({
    principalSub: row.principal_sub,
    mediaId: row.media_id,
    geminiFileName: row.gemini_file_name,
    geminiFileUri: row.gemini_file_uri,
    sha256: row.sha256,
    mimeType: row.mime_type,
    retention: row.retention,
    sealedAt: row.sealed_at,
    expiresAt: row.expires_at,
  });
}

function assertReplay(
  attempt: HostedAnalysisAttempt,
  immutableJson: string,
  expected: string | true,
): HostedAttemptCreateResult {
  if (JSON.stringify(attempt.input) !== immutableJson) {
    throw new HostedRepositoryError("hosted_idempotency_conflict");
  }
  return {
    attempt,
    replayed: expected === true || expected !== attempt.attemptId,
  };
}

function isRetryableStage(stage: HostedAnalysisAttempt["stage"]): boolean {
  return ["failed", "canceled", "indeterminate"].includes(stage);
}
