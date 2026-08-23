import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "vitest";
import { MODEL_REQUEST_TIMEOUT_MS as GEMINI_MODEL_TIMEOUT_MS } from "../../../src/adapters/gemini";
import {
  GEMINI_GENERATION_TRANSPORT_ATTEMPTS,
  GEMINI_STRUCTURED_GENERATIONS_PER_STEP,
} from "../../../src/adapters/gemini-generation-policy";
import {
  HOSTED_PROVIDER_STEP_CONFIG,
  HOSTED_WORKFLOW_STEP_TIMEOUT_MS,
  hostedAttemptSchema,
  type HostedAttemptInput,
} from "../../workflows/src/contracts";
import { buildHostedPublishedRun } from "../../workflows/src/publication";
import { validateVersionedRunImport } from "../../../src/domain/integrity";
import {
  resolveHostedTranscript,
} from "../../workflows/src/provider";
import {
  HostedRepositoryError,
  HostedWorkflowRepository,
  type HostedD1Database,
} from "../../workflows/src/repository";
import {
  hostedSpendEstimator,
  type HostedSpendPolicyConfig,
} from "../../workflows/src/spend";

const principalA = "hosted-principal-a";
const principalB = "hosted-principal-b";
const now = "2026-08-22T12:00:00.000Z";
const later = "2026-08-29T12:00:00.000Z";
const sha256 = "a".repeat(64);
const spendConfig: HostedSpendPolicyConfig = {
  videoTokensPerSecond: 300,
  promptOutputHeadroomPerCall: 100,
  maxInterrogationCalls: 1,
  principalCapUnits: 23_999,
};
const spendPlan = hostedSpendEstimator.estimate(1, spendConfig);

describe("hosted Workflow durability", () => {
  test("keeps provider retries off and the Workflow timeout above the model timeout", () => {
    expect(HOSTED_PROVIDER_STEP_CONFIG.retries.limit).toBe(0);
    expect(HOSTED_WORKFLOW_STEP_TIMEOUT_MS).toBeGreaterThan(
      GEMINI_MODEL_TIMEOUT_MS,
    );
    expect(spendPlan).toMatchObject({
      version: "hosted-video-v2",
      callGraph: {
        structuredGenerationsPerCall: GEMINI_STRUCTURED_GENERATIONS_PER_STEP,
        transportAttemptsPerGeneration: GEMINI_GENERATION_TRANSPORT_ATTEMPTS,
      },
      estimatedTokens: 12_000,
    });
  });

  test("passes an explicit config to every step.do call", async () => {
    const source = await readFile(
      new URL("../../workflows/src/index.ts", import.meta.url),
      "utf8",
    );
    const calls = source.match(/\bstep\.do\(/g) ?? [];
    const configuredCalls = source.match(
      /\bstep\.do\(\s*(?:input\.providerStepName|"[^"]+")\s*,\s*HOSTED_(?:STATE|PROVIDER)_STEP_CONFIG/g,
    ) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(configuredCalls).toHaveLength(calls.length);
  });

  test("uses the transcript ladder without requiring local ffmpeg", () => {
    expect(resolveHostedTranscript({
      meeting: {
        id: "meeting-1",
        title: "Contract meeting",
        provider: "file",
        transport: "file",
        transcript: "Operator transcript",
      },
      derivedSegments: [{
        start: "00:00:00",
        end: "00:00:01",
        speaker: "Speaker 1",
        text: "Derived transcript",
      }],
    })).toMatchObject({ origin: "operator", text: "Operator transcript" });
    expect(resolveHostedTranscript({
      derivedSegments: [{
        start: "00:00:00",
        end: "00:00:01",
        speaker: "Speaker 1",
        text: "Derived transcript",
      }],
    })).toMatchObject({ origin: "gemini-audio" });
    expect(resolveHostedTranscript({})).toEqual({ origin: "none" });
  });

  test("batch-loads display receipts while omitting an invalid legacy row", async () => {
    const fixture = await hostedRepositoryFixture();
    try {
      await seedMedia(fixture.database, principalA, "media_display_valid_0001");
      await fixture.database.prepare(`
        INSERT INTO hosted_media_receipts (
          principal_sub, media_id, gemini_file_name, gemini_file_uri, sha256,
          mime_type, retention, sealed_at, expires_at, duration_seconds, size_bytes
        ) VALUES (?, ?, ?, ?, ?, 'video/mp4', 'retained', ?, ?, 20, NULL)
      `).bind(
        principalA,
        "media_display_legacy_0001",
        "files/media_display_legacy_0001",
        "https://generativelanguage.googleapis.test/v1beta/files/media_display_legacy_0001",
        sha256,
        now,
        later,
      ).run();
      const repository = new HostedWorkflowRepository(
        fixture.database as unknown as HostedD1Database,
      );
      const receipts = await repository.getMediaReceiptsForDisplay(
        principalA,
        [
          "media_display_valid_0001",
          "media_display_legacy_0001",
          "media_display_valid_0001",
        ],
      );
      expect([...receipts.keys()]).toEqual(["media_display_valid_0001"]);
      expect(receipts.get("media_display_valid_0001")).toMatchObject({
        durationSeconds: 1,
        sizeBytes: 1024,
      });
    } finally {
      await fixture.miniflare.dispose();
    }
  });

  test("builds a real validated pair and rejects mismatched publication input", async () => {
    const attempt = hostedAttemptSchema.parse({
      principalSub: principalA,
      attemptId: "attempt_publication_0001",
      jobId: "job_publication_0001",
      attemptNumber: 1,
      idempotencyKey: "publication-test-key",
      workflowInstanceId: "workflow_publication_0001",
      input: {
        ...hostedInput("media_publication_0001"),
        recipe: {
          id: "decisions",
          label: "Decisions",
          revision: "builtin-2026-08-11.1",
          sha256: "b".repeat(64),
        },
      },
      stage: "publish",
      spendReservedUnits: 1,
      cleanupCompletedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const candidate = {
      start: "00:00:01",
      end: "00:00:02",
      summary: "A decision was made.",
      kind: "decision",
      importance: "high" as const,
    };
    const result = {
      accepted: true,
      kind: "decision",
      title: "Use the durable pair",
      summary: "The run bundle remains authoritative.",
      importance: "high" as const,
    };
    const base = {
      attempt,
      transcript: { origin: "none" as const },
      matchNotes: "Recording-only evidence.",
      moments: [candidate],
      details: [result],
      file: { name: "files/publication", uri: "https://example.test/files/publication", mimeType: "video/mp4" },
      cleanup: { deleted: false, completedAt: now },
      publishedAt: later,
    };
    const pair = await buildHostedPublishedRun(base);
    await expect(validateVersionedRunImport(pair)).resolves.toEqual(pair);
    expect(pair.manifest).toMatchObject({
      runId: `hosted_${attempt.attemptId}`,
      remoteFile: { name: "files/publication", deleted: false },
      artifacts: ["analysis.json", "manifest.json"],
    });
    await expect(buildHostedPublishedRun({ ...base, details: [] }))
      .rejects.toThrow("hosted_publication_item_count_mismatch");
    const invalid = structuredClone(pair);
    invalid.manifest.analysisSha256 = "0".repeat(64);
    await expect(validateVersionedRunImport(invalid)).rejects.toThrow();
    const schemaMismatch = structuredClone(pair) as unknown as {
      analysis: typeof pair.analysis;
      manifest: Record<string, unknown>;
    };
    schemaMismatch.manifest.schemaVersion = 2;
    await expect(validateVersionedRunImport(schemaMismatch as never))
      .rejects.toThrow();
  });

  test("fails migration 0004 closed when a legacy sentinel exists", async () => {
    const fixture = await hostedRepositoryFixture(false);
    try {
      await fixture.database.prepare(`
        INSERT INTO analysis_run_registry (
          principal_sub, run_id, schema_version
        ) VALUES ('__legacy_unclaimed__', 'legacy_hosted_guard', 2)
      `).run();
      const migration = await readFile(
        new URL("../db/migrations/0004_hosted_workflows.sql", import.meta.url),
        "utf8",
      );
      await expect(applyMigration(fixture.database, migration)).rejects.toThrow(
        /hosted_workflows_require_scoped_projection/,
      );
      expect((await fixture.database.prepare(`
        SELECT count(*) AS count FROM sqlite_schema
        WHERE name = 'hosted_analysis_attempts'
      `).first<{ count: number }>())?.count).toBe(0);
    } finally {
      await fixture.miniflare.dispose();
    }
  });

  test("atomically reserves spend, deduplicates submits, and links fresh retries", async () => {
    const fixture = await hostedRepositoryFixture();
    try {
      await seedPrincipal(fixture.database, principalA, spendConfig.principalCapUnits);
      await seedPrincipal(fixture.database, principalB, spendConfig.principalCapUnits);
      await seedMedia(fixture.database, principalA, "media_contract_0001");
      await seedMedia(fixture.database, principalB, "media_contract_0001");
      const repository = new HostedWorkflowRepository(
        fixture.database as unknown as HostedD1Database,
      );
      const immutableInput = hostedInput("media_contract_0001");
      const create = (suffix: string) => repository.createInitialAttempt({
        principalSub: principalA,
        principalEmail: "seat@example.test",
        idempotencyKey: "initial-submit-key",
        immutableInput,
        createdAt: now,
        jobId: `job_contract_${suffix}`,
        attemptId: `attempt_contract_${suffix}`,
        workflowInstanceId: `workflow_contract_${suffix}`,
      });
      const [first, second] = await Promise.all([create("0001"), create("0002")]);
      expect(first.attempt.attemptId).toBe(second.attempt.attemptId);
      expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
      expect((await fixture.database.prepare(
        "SELECT count(*) AS count FROM hosted_analysis_jobs WHERE principal_sub = ?",
      ).bind(principalA).first<{ count: number }>())?.count).toBe(1);
      expect((await fixture.database.prepare(
        "SELECT count(*) AS count FROM hosted_spend_reservations WHERE principal_sub = ? AND state = 'reserved'",
      ).bind(principalA).first<{ count: number }>())?.count).toBe(1);

      await expect(repository.createInitialAttempt({
        principalSub: principalA,
        idempotencyKey: "second-spend-key",
        immutableInput,
        createdAt: now,
        jobId: "job_contract_0003",
        attemptId: "attempt_contract_0003",
        workflowInstanceId: "workflow_contract_0003",
      })).rejects.toMatchObject({ code: "principal_spend_cap_exceeded" });

      const claims = await Promise.all([
        repository.claimProviderCall(
          principalA,
          first.attempt.attemptId,
          "transcribe",
          "gemini_transcribe_started",
          now,
        ),
        repository.claimProviderCall(
          principalA,
          first.attempt.attemptId,
          "transcribe",
          "gemini_transcribe_started",
          now,
        ),
      ]);
      expect(claims.sort()).toEqual([false, true]);
      expect((await fixture.database.prepare(`
        SELECT count(*) AS count FROM hosted_provider_claims
        WHERE principal_sub = ? AND attempt_id = ? AND step_name = 'transcribe'
      `).bind(principalA, first.attempt.attemptId).first<{ count: number }>())?.count)
        .toBe(1);
      await repository.recordProviderUsage({
        principalSub: principalA,
        attemptId: first.attempt.attemptId,
        stepName: "transcribe",
        usage: { promptTokens: 80, outputTokens: 20, totalTokens: 100 },
        occurredAt: now,
      });
      expect((await fixture.database.prepare(`
        SELECT count(*) AS count FROM hosted_analysis_events
        WHERE principal_sub = ? AND attempt_id = ?
          AND event_kind = 'provider_call'
          AND code = 'gemini_transcribe_started'
      `).bind(principalA, first.attempt.attemptId).first<{ count: number }>())?.count)
        .toBe(1);

      await repository.putReceipt(
        principalA,
        first.attempt.attemptId,
        "transcribe",
        { request: "provider-call-1" },
        now,
      );
      await expect(repository.putReceipt(
        principalA,
        first.attempt.attemptId,
        "transcribe",
        { request: "provider-call-2" },
        now,
      )).rejects.toMatchObject({ code: "workflow_receipt_conflict" });
      const reconciliation = await repository.finishAttempt({
        principalSub: principalA,
        attemptId: first.attempt.attemptId,
        stage: "indeterminate",
        occurredAt: now,
        errorCode: "provider_receipt_missing_after_success",
        cleanupCompleted: true,
      });
      expect(reconciliation).toMatchObject({
        reservedUnits: spendPlan.estimatedTokens,
        actualUnits: 100,
        committedUnits: 100,
        code: "spend_reconciled_provider_usage",
      });

      const retry = (suffix: string) => repository.createLinkedRetry({
        principalSub: principalA,
        parentAttemptId: first.attempt.attemptId,
        idempotencyKey: "retry-submit-key",
        createdAt: now,
        attemptId: `attempt_retry_${suffix}`,
        workflowInstanceId: `workflow_retry_${suffix}`,
      });
      const [retryOne, retryTwo] = await Promise.all([
        retry("00000001"),
        retry("00000002"),
      ]);
      expect(retryOne.attempt.attemptId).toBe(retryTwo.attempt.attemptId);
      expect(retryOne.attempt.attemptId).not.toBe(first.attempt.attemptId);
      expect(retryOne.attempt.workflowInstanceId).not.toBe(
        first.attempt.workflowInstanceId,
      );
      expect(retryOne.attempt.retryOfAttemptId).toBe(first.attempt.attemptId);
      expect(await repository.getReceipt(
        principalA,
        first.attempt.attemptId,
        "transcribe",
      )).toBeDefined();
      expect(await repository.getAttempt(principalB, first.attempt.attemptId))
        .toBeUndefined();
      await repository.requestCancellation(
        principalA,
        retryOne.attempt.attemptId,
        now,
      );
      await expect(repository.assertNotCanceled(
        principalA,
        retryOne.attempt.attemptId,
      )).rejects.toMatchObject({ code: "operator_canceled" });
      const canceled = await repository.finishAttempt({
        principalSub: principalA,
        attemptId: retryOne.attempt.attemptId,
        stage: "canceled",
        occurredAt: now,
        errorCode: "operator_canceled",
        cleanupCompleted: true,
      });
      expect(canceled).toMatchObject({
        committedUnits: 0,
        reservationState: "released",
        code: "spend_released_zero_claims",
      });
      await seedMedia(
        fixture.database,
        principalA,
        "media_expired_0001",
        "2026-08-22T11:00:00.000Z",
        "2026-08-21T12:00:00.000Z",
      );
      await expect(repository.requireUsableMediaReceipt(
        principalA,
        "media_expired_0001",
        now,
      )).rejects.toMatchObject({ code: "sealed_media_receipt_expired" });
    } finally {
      await fixture.miniflare.dispose();
    }
  });

  test("never exceeds one principal cap across concurrent unique creates", async () => {
    const fixture = await hostedRepositoryFixture();
    try {
      const capUnits = spendPlan.estimatedTokens * 3;
      await seedPrincipal(fixture.database, principalA, capUnits);
      await seedMedia(fixture.database, principalA, "media_spend_race_0001");
      const repository = new HostedWorkflowRepository(
        fixture.database as unknown as HostedD1Database,
      );
      const attempts = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) => {
          const suffix = String(index + 1).padStart(4, "0");
          return repository.createInitialAttempt({
            principalSub: principalA,
            idempotencyKey: `spend-race-key-${suffix}`,
            immutableInput: hostedInput("media_spend_race_0001"),
            createdAt: now,
            jobId: `job_spend_race_${suffix}`,
            attemptId: `attempt_spend_race_${suffix}`,
            workflowInstanceId: `workflow_spend_race_${suffix}`,
          });
        }),
      );
      const created = attempts.filter((result) => result.status === "fulfilled");
      const rejected = attempts.filter((result) => result.status === "rejected");
      expect(created).toHaveLength(3);
      expect(rejected).toHaveLength(17);
      expect(rejected.every((result) =>
        result.status === "rejected"
        && result.reason instanceof HostedRepositoryError
        && result.reason.code === "principal_spend_cap_exceeded"
      )).toBe(true);
      const active = await fixture.database.prepare(`
        SELECT COALESCE(SUM(reserved_units), 0) AS units
        FROM hosted_spend_reservations
        WHERE principal_sub = ? AND state = 'reserved'
      `).bind(principalA).first<{ units: number }>();
      expect(active?.units).toBe(capUnits);
    } finally {
      await fixture.miniflare.dispose();
    }
  });

  test("fails actual spend overrun closed without committing above the reservation", async () => {
    const fixture = await hostedRepositoryFixture();
    try {
      await seedPrincipal(fixture.database, principalA, spendPlan.estimatedTokens * 2);
      await seedMedia(fixture.database, principalA, "media_overrun_0001");
      const repository = new HostedWorkflowRepository(
        fixture.database as unknown as HostedD1Database,
      );
      const created = await repository.createInitialAttempt({
        principalSub: principalA,
        idempotencyKey: "overrun-key",
        immutableInput: hostedInput("media_overrun_0001"),
        createdAt: now,
        jobId: "job_overrun_0001",
        attemptId: "attempt_overrun_0001",
        workflowInstanceId: "workflow_overrun_0001",
      });
      await repository.claimProviderCall(
        principalA,
        created.attempt.attemptId,
        "transcribe",
        "gemini_transcribe_started",
        now,
      );
      await repository.recordProviderUsage({
        principalSub: principalA,
        attemptId: created.attempt.attemptId,
        stepName: "transcribe",
        usage: {
          promptTokens: spendPlan.estimatedTokens,
          outputTokens: 1,
          totalTokens: spendPlan.estimatedTokens + 1,
        },
        occurredAt: now,
      });
      await expect(repository.assertSpendWithinReservation(
        principalA,
        created.attempt.attemptId,
      )).rejects.toMatchObject({ code: "spend_actual_exceeds_reservation" });
      const reconciliation = await repository.finishAttempt({
        principalSub: principalA,
        attemptId: created.attempt.attemptId,
        stage: "succeeded",
        occurredAt: now,
        runId: "run_must_not_publish",
        cleanupCompleted: true,
      });
      expect(reconciliation).toMatchObject({
        actualUnits: spendPlan.estimatedTokens + 1,
        committedUnits: spendPlan.estimatedTokens,
        reservationState: "committed",
        code: "spend_actual_exceeds_reservation",
      });
      expect(await repository.getAttempt(principalA, created.attempt.attemptId))
        .toMatchObject({
          stage: "indeterminate",
          errorCode: "spend_actual_exceeds_reservation",
        });
      expect((await fixture.database.prepare(`
        SELECT committed_units FROM hosted_principal_spend WHERE principal_sub = ?
      `).bind(principalA).first<{ committed_units: number }>())?.committed_units)
        .toBe(spendPlan.estimatedTokens);
    } finally {
      await fixture.miniflare.dispose();
    }
  });

  test("releases expired zero-claim reservations with an idempotent principal janitor", async () => {
    const fixture = await hostedRepositoryFixture();
    try {
      await seedPrincipal(fixture.database, principalA, spendPlan.estimatedTokens * 2);
      await seedMedia(fixture.database, principalA, "media_janitor_0001");
      const repository = new HostedWorkflowRepository(
        fixture.database as unknown as HostedD1Database,
      );
      const created = await repository.createInitialAttempt({
        principalSub: principalA,
        idempotencyKey: "janitor-key",
        immutableInput: hostedInput("media_janitor_0001"),
        createdAt: now,
        jobId: "job_janitor_0001",
        attemptId: "attempt_janitor_0001",
        workflowInstanceId: "workflow_janitor_0001",
      });
      await fixture.database.prepare(`
        UPDATE hosted_media_receipts SET expires_at = ?
        WHERE principal_sub = ? AND media_id = ?
      `).bind("2026-08-22T11:00:00.000Z", principalA, "media_janitor_0001").run();
      expect(await repository.reconcileStaleSpendReservations({
        principalSub: principalA,
        occurredAt: now,
      })).toEqual({ released: 1, committed: 0 });
      expect(await repository.reconcileStaleSpendReservations({
        principalSub: principalA,
        occurredAt: now,
      })).toEqual({ released: 0, committed: 0 });
      expect(await repository.getAttempt(principalA, created.attempt.attemptId))
        .toMatchObject({ stage: "failed", errorCode: "spend_reservation_expired" });
      expect(await fixture.database.prepare(`
        SELECT state, reconciliation_code FROM hosted_spend_reservations
        WHERE principal_sub = ? AND attempt_id = ?
      `).bind(principalA, created.attempt.attemptId).first())
        .toMatchObject({
          state: "released",
          reconciliation_code: "spend_released_zero_claims",
        });
    } finally {
      await fixture.miniflare.dispose();
    }
  });
});

function hostedInput(mediaId: string): HostedAttemptInput {
  return {
    mediaId,
    mediaSha256: sha256,
    context: { mode: "none" },
    recipe: {
      id: "critical-decisions",
      label: "Critical decisions",
      revision: "builtin-test",
      sha256: "b".repeat(64),
    },
    model: "gemini-test",
    retention: "retained",
    spendPlan,
  };
}

async function hostedRepositoryFixture(includeHostedMigration = true) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "frame-of-mind-hosted-workflow-test" },
  });
  const database = await miniflare.getD1Database("DB");
  const names = [
    "0001_initial.sql",
    "0002_video_only_projection.sql",
    "0003_principal_scope.sql",
    ...(includeHostedMigration
      ? [
          "0004_hosted_workflows.sql",
          "0005_hosted_spend_telemetry.sql",
          "0007_hosted_direct_media.sql",
          "0008_hosted_retention_evidence.sql",
        ]
      : []),
  ];
  for (const name of names) {
    const sql = await readFile(
      new URL(`../db/migrations/${name}`, import.meta.url),
      "utf8",
    );
    await applyMigration(database, sql);
  }
  return { miniflare, database };
}

async function applyMigration(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  sql: string,
): Promise<void> {
  await database.batch(sql.replace(/^--.*$/gm, "").split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement)));
}

async function seedPrincipal(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  principalSub: string,
  capUnits: number,
) {
  await database.prepare(`
    INSERT INTO hosted_principal_spend (
      principal_sub, principal_email, cap_units, committed_units, updated_at
    ) VALUES (?, ?, ?, 0, ?)
  `).bind(principalSub, "seat@example.test", capUnits, now).run();
}

async function seedMedia(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  principalSub: string,
  mediaId: string,
  expiresAt = later,
  sealedAt = now,
) {
  await database.prepare(`
    INSERT INTO hosted_media_receipts (
      principal_sub, media_id, gemini_file_name, gemini_file_uri, sha256,
      mime_type, retention, sealed_at, expires_at
      , duration_seconds, size_bytes
    ) VALUES (?, ?, ?, ?, ?, 'video/mp4', 'retained', ?, ?, 1, 1024)
  `).bind(
    principalSub,
    mediaId,
    `files/${mediaId}`,
    `https://generativelanguage.googleapis.test/v1beta/files/${mediaId}`,
    sha256,
    sealedAt,
    expiresAt,
  ).run();
}
