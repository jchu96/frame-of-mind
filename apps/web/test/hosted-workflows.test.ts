import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "vitest";
import { MODEL_REQUEST_TIMEOUT_MS as GEMINI_MODEL_TIMEOUT_MS } from "../../../src/adapters/gemini";
import {
  HOSTED_PROVIDER_STEP_CONFIG,
  HOSTED_WORKFLOW_STEP_TIMEOUT_MS,
  type HostedAttemptInput,
} from "../../workflows/src/contracts";
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
  principalCapUnits: 2_399,
};
const spendPlan = hostedSpendEstimator.estimate(1, spendConfig);

describe("hosted Workflow durability", () => {
  test("keeps provider retries off and the Workflow timeout above the model timeout", () => {
    expect(HOSTED_PROVIDER_STEP_CONFIG.retries.limit).toBe(0);
    expect(HOSTED_WORKFLOW_STEP_TIMEOUT_MS).toBeGreaterThan(
      GEMINI_MODEL_TIMEOUT_MS,
    );
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
      ? ["0004_hosted_workflows.sql", "0005_hosted_spend_telemetry.sql"]
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
      , duration_seconds
    ) VALUES (?, ?, ?, ?, ?, 'video/mp4', 'retained', ?, ?, 1)
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
