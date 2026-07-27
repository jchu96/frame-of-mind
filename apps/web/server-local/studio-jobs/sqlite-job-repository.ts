import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type {
  InitialJobCreateInput,
  JobCreateResult,
  JobListPage,
  JobListQuery,
  JobRepository,
  JobTransitionInput,
  LinkedRetryCreateInput,
} from "../../../../src/domain/studio-ports";
import {
  analysisJobEventSchema,
  analysisJobSchema,
  analysisJobStageSchema,
  canonicalImmutableJobInputJson,
  digestImmutableJobInput,
  idempotencyKeySchema,
  validateAnalysisJob,
  type AnalysisJob,
  type AnalysisJobEvent,
} from "../../../../src/domain/studio-schemas";
import {
  opaqueIdSchema,
  parseOpaqueResourceId,
} from "../../../../src/domain/studio-identifiers";
import {
  assertAnalysisJobTransition,
  isAnalysisJobTerminal,
} from "../../../../src/domain/studio-state";
import type { AnalysisJobStage } from "../../../../src/domain/studio-types";
import { studioJobSchemaSql } from "./sql";

const MAX_JOB_PAGE_SIZE = 100;
const retryableTerminalStages = new Set<AnalysisJobStage>([
  "failed",
  "canceled",
  "interrupted",
]);
const jobCursorSchema = z.tuple([
  z.string().datetime({ offset: false }),
  opaqueIdSchema,
]);

interface JobRow {
  id: string;
  root_job_id: string;
  retry_of_job_id: string | null;
  attempt: number;
  idempotency_key: string;
  input_digest: string;
  stage: string;
  cancellation_requested_at: string | null;
  input_json: string;
  terminal_outcome: string | null;
  terminal_at: string | null;
  terminal_code: string | null;
  terminal_message: string | null;
  run_id: string | null;
  projection_warning: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  job_id: string;
  sequence: number;
  attempt: number;
  kind: string;
  stage: string;
  occurred_at: string;
  event_json: string;
}

type JobInsertParameters = [
  string,
  string,
  string | null,
  number,
  string,
  string,
  string,
  string | null,
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string,
  string,
];

type JobUpdateParameters = [
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string,
  string,
];

type EventInsertParameters = [
  string,
  number,
  number,
  string,
  string,
  string,
  string,
];

export interface LocalSqliteJobRepositoryOptions {
  createId?: () => string;
}

export class StudioJobRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StudioJobRepositoryError";
  }
}

export class LocalSqliteJobRepository implements JobRepository {
  private readonly createId: () => string;

  constructor(
    private readonly database: Database,
    options: LocalSqliteJobRepositoryOptions = {},
  ) {
    this.createId = options.createId ?? defaultJobId;
    this.database.exec(studioJobSchemaSql);
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec("PRAGMA busy_timeout = 5000;");
  }

  async createOrReplay(
    input: InitialJobCreateInput,
  ): Promise<JobCreateResult> {
    const createdAt = normalizeUtc(input.createdAt);
    const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
    const canonicalDigest = await digestImmutableJobInput(
      input.verifiedInput.input,
    );
    if (canonicalDigest !== input.verifiedInput.inputDigest) {
      throw new StudioJobRepositoryError(
        "invalid_input_digest",
        "Verified immutable job input has an invalid digest.",
      );
    }
    const write = this.database.transaction(() => {
      const existing = this.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        const job = this.parseJobRow(existing);
        if (
          job.attempt !== 1
          || job.retryOfJobId
          || job.inputDigest !== canonicalDigest
        ) {
          throw new StudioJobRepositoryError(
            "idempotency_conflict",
            "The idempotency key is already bound to different job input.",
          );
        }
        return { kind: "replayed" as const, job };
      }
      if (input.verifiedInput.input.recipe.custom === undefined) {
        throw new StudioJobRepositoryError(
          "missing_recipe_provenance",
          "New analysis jobs must identify built-in or custom recipe provenance.",
        );
      }
      const id = parseOpaqueResourceId(this.createId());
      const candidate = analysisJobSchema.parse({
        id,
        rootJobId: id,
        attempt: 1,
        idempotencyKey,
        inputDigest: canonicalDigest,
        stage: "queued",
        input: input.verifiedInput.input,
        createdAt,
        updatedAt: createdAt,
      });
      this.insertJob(candidate);
      return { kind: "created" as const, job: candidate };
    });

    const result = write.immediate();
    return {
      kind: result.kind,
      job: await this.validateJob(result.job),
    };
  }

  async get(id: string): Promise<AnalysisJob | undefined> {
    const parsedId = parseOpaqueResourceId(id);
    const row = this.findById(parsedId);
    if (!row) return undefined;
    return this.validateJob(this.parseJobRow(row));
  }

  async list(query: JobListQuery): Promise<JobListPage> {
    if (
      !Number.isSafeInteger(query.limit)
      || query.limit < 1
      || query.limit > MAX_JOB_PAGE_SIZE
    ) {
      throw new StudioJobRepositoryError(
        "invalid_page_size",
        `Job list limit must be between 1 and ${MAX_JOB_PAGE_SIZE}.`,
      );
    }
    const stages = query.stages?.map((stage) =>
      analysisJobStageSchema.parse(stage)
    );
    const stagesJson = stages ? JSON.stringify(stages) : null;
    const cursor = query.cursor ? decodeJobCursor(query.cursor) : undefined;
    const oldestFirst = query.order === "oldest";
    const comparator = oldestFirst ? ">" : "<";
    const direction = oldestFirst ? "ASC" : "DESC";
    const rows = cursor
      ? this.database
        .query<
          JobRow,
          [string | null, string | null, string, string, string, number]
        >(
          `SELECT * FROM studio_analysis_jobs
           WHERE (? IS NULL OR stage IN (SELECT value FROM json_each(?)))
             AND (
               created_at ${comparator} ?
               OR (created_at = ? AND id ${comparator} ?)
             )
           ORDER BY created_at ${direction}, id ${direction}
           LIMIT ?`,
        )
        .all(
          stagesJson,
          stagesJson,
          cursor[0],
          cursor[0],
          cursor[1],
          query.limit + 1,
        )
      : this.database
        .query<JobRow, [string | null, string | null, number]>(
           `SELECT * FROM studio_analysis_jobs
           WHERE (? IS NULL OR stage IN (SELECT value FROM json_each(?)))
           ORDER BY created_at ${direction}, id ${direction}
           LIMIT ?`,
        )
        .all(stagesJson, stagesJson, query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const jobs = await Promise.all(
      pageRows.map((row) => this.validateJob(this.parseJobRow(row))),
    );
    const last = jobs.at(-1);
    return {
      jobs,
      ...(rows.length > query.limit && last
        ? { nextCursor: encodeJobCursor(last) }
        : {}),
    };
  }

  async events(
    jobId: string,
    afterSequence = 0,
  ): Promise<AnalysisJobEvent[]> {
    const parsedId = parseOpaqueResourceId(jobId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new StudioJobRepositoryError(
        "invalid_event_cursor",
        "Event sequence cursor must be a nonnegative integer.",
      );
    }
    const jobRow = this.findById(parsedId);
    if (!jobRow) {
      throw new StudioJobRepositoryError("job_not_found", "Analysis job not found.");
    }
    const job = this.parseJobRow(jobRow);
    return this.database
      .query<EventRow, [string, number]>(
        `SELECT * FROM studio_analysis_job_events
         WHERE job_id = ? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(parsedId, afterSequence)
      .map((row) => this.parseEventRow(row, job.attempt));
  }

  async appendEvent(
    event: Omit<AnalysisJobEvent, "sequence">,
  ): Promise<AnalysisJobEvent> {
    if (
      event.kind === "transition"
      || event.kind === "cancellation_requested"
    ) {
      throw new StudioJobRepositoryError(
        "event_requires_atomic_operation",
        "Transition and cancellation events require their atomic repository operation.",
      );
    }
    const occurredAt = normalizeUtc(event.occurredAt);
    const write = this.database.transaction(() => {
      const job = this.requireJob(event.jobId);
      if (isAnalysisJobTerminal(job.stage)) {
        throw new StudioJobRepositoryError(
          "job_terminal",
          "A terminal job cannot accept progress events.",
        );
      }
      if (event.attempt !== job.attempt || event.stage !== job.stage) {
        throw new StudioJobRepositoryError(
          "event_job_mismatch",
          "Event attempt and stage must match the current job.",
        );
      }
      assertMonotonicTime(job.updatedAt, occurredAt);
      const sequence = this.nextSequence(job.id);
      const validated = analysisJobEventSchema.parse({
        ...event,
        occurredAt,
        sequence,
      });
      const updated = analysisJobSchema.parse({
        ...job,
        updatedAt: occurredAt,
      });
      this.updateJob(updated);
      this.insertEvent(validated);
      return validated;
    });
    return write.immediate();
  }

  async transition(input: JobTransitionInput): Promise<AnalysisJob> {
    const occurredAt = normalizeUtc(input.occurredAt);
    const write = this.database.transaction(() => {
      const job = this.requireJob(input.jobId);
      if (job.stage !== input.expectedStage) {
        throw new StudioJobRepositoryError(
          "stage_conflict",
          "Analysis job stage changed before this transition.",
        );
      }
      try {
        assertAnalysisJobTransition(job.stage, input.nextStage);
      } catch {
        throw new StudioJobRepositoryError(
          "invalid_transition",
          `Analysis job cannot transition from ${job.stage} to ${input.nextStage}.`,
        );
      }
      assertMonotonicTime(job.updatedAt, occurredAt);
      if (
        job.runId
        && isAnalysisJobTerminal(input.nextStage)
        && input.nextStage !== "succeeded"
      ) {
        throw new StudioJobRepositoryError(
          "published_run_requires_success",
          "A job with a published run can only complete successfully.",
        );
      }
      if (job.runId && input.runId && input.runId !== job.runId) {
        throw new StudioJobRepositoryError(
          "published_run_conflict",
          "A published run identifier cannot be replaced.",
        );
      }

      const message = input.message
        ?? `Transitioned from ${job.stage} to ${input.nextStage}.`;
      const carriesPublishedRun =
        input.nextStage === "cleaning_up"
        || input.nextStage === "succeeded";
      const terminal = isAnalysisJobTerminal(input.nextStage)
        ? {
            outcome: input.nextStage,
            at: occurredAt,
            ...(input.code ? { code: input.code } : {}),
            ...(input.message ? { message: input.message } : {}),
          }
        : undefined;
      const candidate = analysisJobSchema.parse({
        ...job,
        stage: input.nextStage,
        updatedAt: occurredAt,
        ...(terminal ? { terminal } : { terminal: undefined }),
        ...(carriesPublishedRun
          ? {
              runId: job.runId ?? input.runId,
              projectionWarning:
                input.projectionWarning ?? job.projectionWarning,
            }
          : {
              runId: undefined,
              projectionWarning: undefined,
            }),
      });
      const event = analysisJobEventSchema.parse({
        jobId: job.id,
        attempt: job.attempt,
        sequence: this.nextSequence(job.id),
        kind: "transition",
        previousStage: job.stage,
        stage: input.nextStage,
        occurredAt,
        message,
      });
      this.updateJob(candidate);
      this.insertEvent(event);
      return candidate;
    });
    return this.validateJob(write.immediate());
  }

  async requestCancellation(
    jobId: string,
    requestedAtInput: string,
  ): Promise<AnalysisJob> {
    const requestedAt = normalizeUtc(requestedAtInput);
    const write = this.database.transaction(() => {
      const job = this.requireJob(jobId);
      if (job.cancellationRequestedAt) return job;
      if (isAnalysisJobTerminal(job.stage)) {
        throw new StudioJobRepositoryError(
          "job_not_cancelable",
          "A terminal job cannot be canceled.",
        );
      }
      if (job.runId) {
        throw new StudioJobRepositoryError(
          "job_not_cancelable",
          "A job cannot be canceled after its durable run is published.",
        );
      }
      assertMonotonicTime(job.updatedAt, requestedAt);
      const candidate = analysisJobSchema.parse({
        ...job,
        cancellationRequestedAt: requestedAt,
        updatedAt: requestedAt,
      });
      const event = analysisJobEventSchema.parse({
        jobId: job.id,
        attempt: job.attempt,
        sequence: this.nextSequence(job.id),
        kind: "cancellation_requested",
        stage: job.stage,
        occurredAt: requestedAt,
        message: "Cancellation requested by the local operator.",
      });
      this.updateJob(candidate);
      this.insertEvent(event);
      return candidate;
    });
    return this.validateJob(write.immediate());
  }

  async createLinkedRetry(
    input: LinkedRetryCreateInput,
  ): Promise<JobCreateResult> {
    const parentId = parseOpaqueResourceId(input.parentJobId);
    const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
    const createdAt = normalizeUtc(input.createdAt);
    const parentSnapshot = await this.get(parentId);
    if (!parentSnapshot) {
      throw new StudioJobRepositoryError("job_not_found", "Analysis job not found.");
    }
    const write = this.database.transaction(() => {
      const parent = this.requireJob(parentId);
      if (
        parent.inputDigest !== parentSnapshot.inputDigest
        || canonicalImmutableJobInputJson(parent.input)
          !== canonicalImmutableJobInputJson(parentSnapshot.input)
      ) {
        throw new StudioJobRepositoryError(
          "corrupt_job",
          "Retry parent changed during immutable-input verification.",
        );
      }
      const existing = this.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        const job = this.parseJobRow(existing);
        if (
          job.retryOfJobId !== parent.id
          || job.inputDigest !== parent.inputDigest
        ) {
          throw new StudioJobRepositoryError(
            "idempotency_conflict",
            "The idempotency key is already bound to different retry input.",
          );
        }
        return { kind: "replayed" as const, job };
      }
      if (!retryableTerminalStages.has(parent.stage)) {
        throw new StudioJobRepositoryError(
          "job_not_retryable",
          "Only failed, canceled, or interrupted jobs may be retried.",
        );
      }
      assertMonotonicTime(parent.updatedAt, createdAt);
      const newId = parseOpaqueResourceId(this.createId());
      const attemptRow = this.database
        .query<{ attempt: number }, [string]>(
          `SELECT coalesce(max(attempt), 0) + 1 AS attempt
           FROM studio_analysis_jobs WHERE root_job_id = ?`,
        )
        .get(parent.rootJobId);
      const attempt = attemptRow?.attempt ?? parent.attempt + 1;
      const candidate = analysisJobSchema.parse({
        id: newId,
        rootJobId: parent.rootJobId,
        retryOfJobId: parent.id,
        attempt,
        idempotencyKey,
        inputDigest: parent.inputDigest,
        stage: "queued",
        input: parent.input,
        createdAt,
        updatedAt: createdAt,
      });
      this.insertJob(candidate);
      return { kind: "created" as const, job: candidate };
    });
    const result = write.immediate();
    return {
      kind: result.kind,
      job: await this.validateJob(result.job),
    };
  }

  private requireJob(id: string): AnalysisJob {
    const parsedId = parseOpaqueResourceId(id);
    const row = this.findById(parsedId);
    if (!row) {
      throw new StudioJobRepositoryError("job_not_found", "Analysis job not found.");
    }
    return this.parseJobRow(row);
  }

  private findById(id: string): JobRow | null {
    return this.database
      .query<JobRow, [string]>(
        "SELECT * FROM studio_analysis_jobs WHERE id = ?",
      )
      .get(id);
  }

  private findByIdempotencyKey(key: string): JobRow | null {
    return this.database
      .query<JobRow, [string]>(
        "SELECT * FROM studio_analysis_jobs WHERE idempotency_key = ?",
      )
      .get(key);
  }

  private insertJob(job: AnalysisJob): void {
    this.database
      .query<never, JobInsertParameters>(
        `INSERT INTO studio_analysis_jobs (
          id, root_job_id, retry_of_job_id, attempt, idempotency_key,
          input_digest, stage, cancellation_requested_at, input_json,
          terminal_outcome, terminal_at, terminal_code, terminal_message,
          run_id, projection_warning, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...jobToParameters(job));
  }

  private updateJob(job: AnalysisJob): void {
    this.database
      .query<never, JobUpdateParameters>(
        `UPDATE studio_analysis_jobs SET
          stage = ?,
          cancellation_requested_at = ?,
          terminal_outcome = ?,
          terminal_at = ?,
          terminal_code = ?,
          terminal_message = ?,
          run_id = ?,
          projection_warning = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        job.stage,
        job.cancellationRequestedAt ?? null,
        job.terminal?.outcome ?? null,
        job.terminal?.at ?? null,
        job.terminal?.code ?? null,
        job.terminal?.message ?? null,
        job.runId ?? null,
        job.projectionWarning ?? null,
        job.updatedAt,
        job.id,
      );
  }

  private insertEvent(event: AnalysisJobEvent): void {
    this.database
      .query<never, EventInsertParameters>(
        `INSERT INTO studio_analysis_job_events (
          job_id, sequence, attempt, kind, stage, occurred_at, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.jobId,
        event.sequence,
        event.attempt,
        event.kind,
        event.stage,
        event.occurredAt,
        JSON.stringify(event),
      );
  }

  private nextSequence(jobId: string): number {
    return this.database
      .query<{ sequence: number }, [string]>(
        `SELECT coalesce(max(sequence), 0) + 1 AS sequence
         FROM studio_analysis_job_events WHERE job_id = ?`,
      )
      .get(jobId)?.sequence ?? 1;
  }

  private parseJobRow(row: JobRow): AnalysisJob {
    try {
      const job = analysisJobSchema.parse({
        id: row.id,
        rootJobId: row.root_job_id,
        ...(row.retry_of_job_id
          ? { retryOfJobId: row.retry_of_job_id }
          : {}),
        attempt: row.attempt,
        idempotencyKey: row.idempotency_key,
        inputDigest: row.input_digest,
        stage: row.stage,
        ...(row.cancellation_requested_at
          ? { cancellationRequestedAt: row.cancellation_requested_at }
          : {}),
        input: JSON.parse(row.input_json),
        ...(row.terminal_outcome && row.terminal_at
          ? {
              terminal: {
                outcome: row.terminal_outcome,
                at: row.terminal_at,
                ...(row.terminal_code ? { code: row.terminal_code } : {}),
                ...(row.terminal_message
                  ? { message: row.terminal_message }
                  : {}),
              },
            }
          : {}),
        ...(row.run_id ? { runId: row.run_id } : {}),
        ...(row.projection_warning
          ? { projectionWarning: row.projection_warning }
          : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      if (
        createHash("sha256")
          .update(canonicalImmutableJobInputJson(job.input), "utf8")
          .digest("hex") !== job.inputDigest
      ) {
        throw new Error("immutable input digest diverged");
      }
      return job;
    } catch {
      throw new StudioJobRepositoryError(
        "corrupt_job",
        "Persisted analysis job failed contract validation.",
      );
    }
  }

  private parseEventRow(
    row: EventRow,
    expectedAttempt: number,
  ): AnalysisJobEvent {
    try {
      const event = analysisJobEventSchema.parse(JSON.parse(row.event_json));
      if (
        event.jobId !== row.job_id
        || event.sequence !== row.sequence
        || event.attempt !== row.attempt
        || event.attempt !== expectedAttempt
        || event.kind !== row.kind
        || event.stage !== row.stage
        || event.occurredAt !== row.occurred_at
      ) {
        throw new Error("normalized event columns diverged");
      }
      return event;
    } catch {
      throw new StudioJobRepositoryError(
        "corrupt_event",
        "Persisted analysis job event failed contract validation.",
      );
    }
  }

  private async validateJob(job: AnalysisJob): Promise<AnalysisJob> {
    try {
      return await validateAnalysisJob(job);
    } catch {
      throw new StudioJobRepositoryError(
        "corrupt_job",
        "Persisted analysis job failed immutable-input validation.",
      );
    }
  }
}

function jobToParameters(job: AnalysisJob): JobInsertParameters {
  return [
    job.id,
    job.rootJobId,
    job.retryOfJobId ?? null,
    job.attempt,
    job.idempotencyKey,
    job.inputDigest,
    job.stage,
    job.cancellationRequestedAt ?? null,
    JSON.stringify(job.input),
    job.terminal?.outcome ?? null,
    job.terminal?.at ?? null,
    job.terminal?.code ?? null,
    job.terminal?.message ?? null,
    job.runId ?? null,
    job.projectionWarning ?? null,
    job.createdAt,
    job.updatedAt,
  ];
}

function defaultJobId(): string {
  return `job_${randomBytes(18).toString("base64url")}`;
}

function normalizeUtc(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new StudioJobRepositoryError(
      "invalid_timestamp",
      "Job timestamps must be valid UTC date-times.",
    );
  }
  const normalized = new Date(milliseconds).toISOString();
  if (!value.endsWith("Z")) {
    throw new StudioJobRepositoryError(
      "invalid_timestamp",
      "Job timestamps must use UTC.",
    );
  }
  return normalized;
}

function assertMonotonicTime(previous: string, next: string): void {
  if (Date.parse(next) < Date.parse(previous)) {
    throw new StudioJobRepositoryError(
      "invalid_timestamp",
      "Job events cannot precede the current job state.",
    );
  }
}

function encodeJobCursor(job: AnalysisJob): string {
  return Buffer.from(
    JSON.stringify([job.createdAt, job.id]),
    "utf8",
  ).toString("base64url");
}

function decodeJobCursor(value: string): z.infer<typeof jobCursorSchema> {
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    return jobCursorSchema.parse(JSON.parse(json));
  } catch {
    throw new StudioJobRepositoryError(
      "invalid_job_cursor",
      "Job cursor is invalid.",
    );
  }
}
