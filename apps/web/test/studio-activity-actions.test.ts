import { describe, expect, test } from "bun:test";
import type {
  AnalysisJob,
  MediaSession,
} from "../../../src/domain/studio-schemas";
import { ANALYSIS_JOB_STAGES } from "../../../src/domain/studio-types";
import {
  ActivityActionRequestError,
  activityActionErrorMessage,
  createActivityActionTransport,
  loadActivityActionSnapshot,
} from "../server-local/studio-ui/activity-action-client";
import {
  derivePermittedActivityActions,
  retryDenialCode,
} from "../server-local/studio-ui/activity-actions";
import { reduceActivityActionPanelState } from "../server-local/studio-ui/activity-action-panel-state";

const NOW = "2026-08-22T12:00:00.000Z";
const EXPIRES = "2026-08-23T12:00:00.000Z";

function job(
  stage: AnalysisJob["stage"],
  options: {
    code?: string;
    context?: AnalysisJob["input"]["context"];
    projectionWarning?: string;
    retained?: boolean;
    runId?: string;
  } = {},
): AnalysisJob {
  const terminal = ["succeeded", "failed", "canceled", "interrupted"]
    .includes(stage);
  return {
    id: `job_${stage}_0000000001`,
    rootJobId: `job_${stage}_0000000001`,
    attempt: 1,
    idempotencyKey: `activity-${stage}-actions-0001`,
    inputDigest: "a".repeat(64),
    stage,
    input: {
      mediaSessionId: "media_actions_00000001",
      mediaSha256: "b".repeat(64),
      context: options.context ?? { mode: "none" },
      recipe: {
        id: "requirements",
        custom: false,
        revision: "builtin-1",
        sha256: "c".repeat(64),
      },
      model: "gemini-synthetic",
      retention: options.retained === false
        ? { mode: "ephemeral", expiresAt: EXPIRES }
        : { mode: "retained", expiresAt: EXPIRES },
    },
    ...(terminal
      ? {
          terminal: {
            outcome: stage as "succeeded" | "failed" | "canceled" | "interrupted",
            at: NOW,
            ...(options.code ? { code: options.code } : {}),
          },
        }
      : {}),
    ...(stage === "succeeded"
      ? { runId: options.runId ?? "run_actions_000000001" }
      : options.runId ? { runId: options.runId } : {}),
    ...(options.projectionWarning
      ? { projectionWarning: options.projectionWarning }
      : {}),
    createdAt: "2026-08-22T11:00:00.000Z",
    updatedAt: NOW,
  };
}

function media(
  status: MediaSession["status"] = "retained",
  options: Partial<MediaSession> = {},
): MediaSession {
  return {
    id: "media_actions_00000001",
    status,
    expectedBytes: 20,
    receivedBytes: 20,
    partSizeBytes: 20,
    parts: [{
      part: 0,
      offset: 0,
      bytes: 20,
      sha256: "d".repeat(64),
      receivedAt: "2026-08-22T11:01:00.000Z",
    }],
    mimeType: "video/mp4",
    sha256: "b".repeat(64),
    retention: { mode: "retained", expiresAt: EXPIRES },
    createdAt: "2026-08-22T11:00:00.000Z",
    updatedAt: NOW,
    ...options,
  };
}

function actionIds(
  value: ReturnType<typeof derivePermittedActivityActions>,
) {
  return value.actions.map((action) => action.id);
}

describe("Studio Activity permitted action table", () => {
  test("permits cancel only in nonterminal unpublished stages", () => {
    for (const stage of ANALYSIS_JOB_STAGES) {
      const decision = derivePermittedActivityActions({
        job: job(stage),
        media: media(),
        projection: "present",
        now: NOW,
      });
      expect(actionIds(decision).includes("cancel")).toBe(
        !["succeeded", "failed", "canceled", "interrupted"].includes(stage),
      );
    }
    expect(actionIds(derivePermittedActivityActions({
      job: { ...job("queued"), cancellationRequestedAt: NOW },
      media: media(),
      projection: "unknown",
      now: NOW,
    }))).not.toContain("cancel");
    expect(actionIds(derivePermittedActivityActions({
      job: job("cleaning_up", { runId: "run_actions_000000001" }),
      media: media(),
      projection: "unknown",
      now: NOW,
    }))).not.toContain("cancel");
  });

  test("permits retry only from failed or interrupted with the exact reusable receipt", () => {
    for (const stage of ANALYSIS_JOB_STAGES) {
      const decision = derivePermittedActivityActions({
        job: job(stage),
        media: media(),
        projection: "present",
        now: NOW,
      });
      expect(actionIds(decision).includes("retry")).toBe(
        stage === "failed" || stage === "interrupted",
      );
    }
    expect(retryDenialCode(job("failed", { retained: false }), media(), NOW))
      .toBe("media_not_retained");
    expect(retryDenialCode(job("failed"), null, NOW)).toBe("media_not_found");
    expect(retryDenialCode(job("failed"), undefined, NOW))
      .toBe("media_status_unavailable");
    expect(retryDenialCode(job("failed"), media("sealed"), NOW))
      .toBe("media_not_reusable");
    expect(retryDenialCode(job("failed"), media("retained", {
      sha256: "e".repeat(64),
    }), NOW)).toBe("media_digest_mismatch");
    expect(retryDenialCode(job("failed"), media("retained", {
      retention: { mode: "retained", expiresAt: NOW },
    }), NOW)).toBe("media_retention_expired");
  });

  test("permits reconnect only for the failed job's exact provider-auth code", () => {
    const cases: Array<{
      provider: "bluedot" | "granola" | "file";
      code: string;
      expected?: string;
    }> = [
      { provider: "bluedot", code: "bluedot_oauth_not_configured", expected: "Reconnect Bluedot" },
      { provider: "granola", code: "granola_oauth_not_configured", expected: "Reconnect Granola" },
      { provider: "granola", code: "granola_api_not_configured", expected: "Reconnect Granola" },
      { provider: "bluedot", code: "granola_oauth_not_configured" },
      { provider: "file", code: "bluedot_oauth_not_configured" },
      { provider: "granola", code: "gemini_not_configured" },
    ];
    for (const item of cases) {
      const context = item.provider === "file"
        ? {
            provider: "file" as const,
            transport: "file" as const,
            contextFileId: "context_actions_0001",
            contextFileSha256: "f".repeat(64),
          }
        : {
            provider: item.provider,
            transport: "mcp" as const,
            meetingId: "meeting-actions",
          };
      const action = derivePermittedActivityActions({
        job: job("failed", { code: item.code, context }),
        media: media(),
        projection: "unknown",
        now: NOW,
      }).actions.find((candidate) => candidate.id === "reconnect-provider");
      expect(action?.label).toBe(item.expected);
    }
  });

  test("permits re-import only for succeeded results missing from the workspace or carrying a warning", () => {
    expect(actionIds(derivePermittedActivityActions({
      job: job("succeeded"),
      media: media(),
      projection: "missing",
      now: NOW,
    }))).toContain("reimport-results");
    expect(actionIds(derivePermittedActivityActions({
      job: job("succeeded", { projectionWarning: "Import was unavailable." }),
      media: media(),
      projection: "present",
      now: NOW,
    }))).toContain("reimport-results");
    expect(actionIds(derivePermittedActivityActions({
      job: job("succeeded"),
      media: media(),
      projection: "present",
      now: NOW,
    }))).not.toContain("reimport-results");
    expect(actionIds(derivePermittedActivityActions({
      job: job("failed"),
      media: media(),
      projection: "missing",
      now: NOW,
    }))).not.toContain("reimport-results");
  });

  test("permits cleanup remediation only for cleanup_failed media", () => {
    for (const status of [
      "created",
      "uploading",
      "sealed",
      "in_use",
      "retained",
      "expired",
      "aborted",
      "deleting",
      "cleanup_failed",
      "deleted",
      "failed",
    ] as const) {
      const decision = derivePermittedActivityActions({
        job: job("failed"),
        media: media(status, status === "cleanup_failed"
          ? { cleanupFailureCode: "eacces" }
          : {}),
        projection: "unknown",
        now: NOW,
      });
      expect(actionIds(decision).includes("retry-cleanup"))
        .toBe(status === "cleanup_failed");
    }
  });

  test("uses the required plain-language labels and explanations", () => {
    const actions = [
      ...derivePermittedActivityActions({
        job: job("failed", {
          code: "bluedot_oauth_not_configured",
          context: { provider: "bluedot", transport: "mcp", meetingId: "meeting-actions" },
        }),
        media: media("cleanup_failed", { cleanupFailureCode: "eacces" }),
        projection: "unknown",
        now: NOW,
      }).actions,
      ...derivePermittedActivityActions({
        job: job("succeeded", { projectionWarning: "Import failed." }),
        media: media(),
        projection: "missing",
        now: NOW,
      }).actions,
      ...derivePermittedActivityActions({
        job: job("interrupted"),
        media: media(),
        projection: "unknown",
        now: NOW,
      }).actions,
      ...derivePermittedActivityActions({
        job: job("queued"),
        media: media(),
        projection: "unknown",
        now: NOW,
      }).actions,
    ];
    expect(new Set(actions.map((action) => action.label))).toEqual(new Set([
      "Cancel",
      "Retry",
      "Reconnect Bluedot",
      "Re-import results",
      "Retry cleanup",
    ]));
    for (const action of actions) {
      expect(action.description).toMatch(/[.]$/);
      expect(`${action.label} ${action.description}`)
        .not.toMatch(/projection|durable|process/i);
    }
  });
});

describe("Studio Activity action client", () => {
  test("posts cancel and retry with the exact routes and parses replay success", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const failed = job("failed");
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json(
        String(input).endsWith("/retry")
          ? { kind: "replayed", job: failed }
          : failed,
      );
    }) as typeof fetch;
    const transport = createActivityActionTransport(fakeFetch);
    await transport.cancel(failed.id);
    const retry = await transport.retry(failed.id, "studio-retry:actions-0001");
    expect(retry.kind).toBe("replayed");
    expect(calls).toEqual([
      { path: `/api/studio/jobs/${failed.id}/cancel`, body: {} },
      {
        path: `/api/studio/jobs/${failed.id}/retry`,
        body: { idempotencyKey: "studio-retry:actions-0001" },
      },
    ]);
  });

  test("preserves a sanitized response code for inline field messages", async () => {
    const transport = createActivityActionTransport((async () =>
      Response.json(
        { data: { code: "idempotency_conflict" } },
        { status: 409 },
      )) as typeof fetch);
    const error = await transport.retry(
      job("failed").id,
      "studio-retry:actions-0002",
    ).catch((failure) => failure);
    expect(error).toBeInstanceOf(ActivityActionRequestError);
    expect(error.code).toBe("idempotency_conflict");
    expect(activityActionErrorMessage("retry", error.code))
      .toContain("fresh request");
  });

  test("loads missing media and missing results as action inputs without inventing state", async () => {
    const succeeded = job("succeeded");
    const snapshot = await loadActivityActionSnapshot(
      succeeded,
      (async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith("/api/studio/media/")) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch,
    );
    expect(snapshot).toEqual({ media: null, projection: "missing" });
  });
});

describe("Studio Activity action panel states", () => {
  test("moves through inline confirmation, pending, and success", () => {
    const confirming = reduceActivityActionPanelState({}, {
      type: "request-confirmation",
      action: "cancel",
    });
    expect(confirming).toEqual({ confirming: "cancel" });
    const pending = reduceActivityActionPanelState(confirming, {
      type: "start",
      action: "cancel",
    });
    expect(pending).toEqual({ confirming: "cancel", pending: "cancel" });
    expect(reduceActivityActionPanelState(pending, {
      type: "request-confirmation",
      action: "retry",
    })).toBe(pending);
    expect(reduceActivityActionPanelState(pending, {
      type: "succeed",
      message: "Cancellation requested.",
    })).toEqual({ successMessage: "Cancellation requested." });
  });

  test("keeps the inline confirmation open with a field error", () => {
    const pending = reduceActivityActionPanelState({ confirming: "retry" }, {
      type: "start",
      action: "retry",
    });
    expect(reduceActivityActionPanelState(pending, {
      type: "fail",
      message: "The recording can no longer be retried.",
    })).toEqual({
      confirming: "retry",
      fieldMessage: "The recording can no longer be retried.",
    });
  });
});
