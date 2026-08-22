import { describe, expect, test } from "bun:test";
import type {
  AnalysisJob,
  AnalysisJobEvent,
} from "../../../src/domain/studio-schemas";
import {
  activityDisplayState,
  activityGroupForStage,
  deriveActivityTimeline,
  formatRelativeActivity,
  groupActivityJobs,
} from "../server-local/studio-ui/activity-state";
import {
  createJobActivityPoller,
  type JobActivityPollRuntime,
} from "../server-local/studio-ui/use-job-activity";

function job(stage: AnalysisJob["stage"], id = `job_${stage}`): AnalysisJob {
  return {
    id,
    rootJobId: id,
    attempt: 1,
    idempotencyKey: `activity-${stage}-0001`,
    inputDigest: "a".repeat(64),
    stage,
    input: {
      mediaSessionId: "media_01K123456789ABC",
      mediaSha256: "b".repeat(64),
      context: { mode: "none" },
      recipe: {
        id: "requirements",
        custom: false,
        revision: "builtin-1",
        sha256: "c".repeat(64),
      },
      model: "gemini-synthetic",
      retention: { mode: "ephemeral" },
    },
    ...(stage === "succeeded"
      ? {
          runId: "run_01K123456789ABC",
          terminal: {
            outcome: stage,
            at: "2026-08-22T12:07:00.000Z",
          },
        }
      : ["failed", "canceled", "interrupted"].includes(stage)
        ? {
            terminal: {
              outcome: stage as "failed" | "canceled" | "interrupted",
              at: "2026-08-22T12:07:00.000Z",
            },
          }
        : {}),
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: ["succeeded", "failed", "canceled", "interrupted"].includes(stage)
      ? "2026-08-22T12:07:00.000Z"
      : "2026-08-22T12:05:00.000Z",
  };
}

function transition(
  sequence: number,
  previousStage: AnalysisJob["stage"],
  stage: AnalysisJob["stage"],
): AnalysisJobEvent {
  return {
    jobId: "job_01K123456789ABC",
    attempt: 1,
    sequence,
    kind: "transition",
    previousStage,
    stage,
    occurredAt: `2026-08-22T12:0${sequence}:00.000Z`,
    message: `Entered ${stage}.`,
  };
}

describe("Studio Activity state", () => {
  test("maps every stage to the exact list group and five-state display", () => {
    for (const stage of [
      "queued",
      "fetching_context",
      "uploading_to_gemini",
      "indexing",
      "interrogating",
      "rendering",
      "cleaning_up",
    ] as const) {
      expect(activityGroupForStage(stage)).toBe("active");
      expect(activityDisplayState(stage)).toBe("active");
    }
    expect(activityGroupForStage("succeeded")).toBe("finished");
    expect(activityDisplayState("succeeded")).toBe("succeeded");
    for (const stage of ["failed", "canceled", "interrupted"] as const) {
      expect(activityGroupForStage(stage)).toBe("needs-attention");
      expect(activityDisplayState(stage)).toBe(stage);
    }

    const grouped = groupActivityJobs([
      job("queued"),
      job("succeeded"),
      job("failed"),
      job("canceled"),
      job("interrupted"),
    ]);
    expect(grouped.active.map((item) => item.stage)).toEqual(["queued"]);
    expect(grouped.finished.map((item) => item.stage)).toEqual(["succeeded"]);
    expect(grouped["needs-attention"].map((item) => item.stage)).toEqual([
      "failed",
      "canceled",
      "interrupted",
    ]);
  });

  test("formats relative activity from the caller-provided clock", () => {
    const now = "2026-08-22T12:05:00.000Z";
    expect(formatRelativeActivity("2026-08-22T12:04:55.000Z", now)).toBe("just now");
    expect(formatRelativeActivity("2026-08-22T12:04:30.000Z", now)).toBe("30 seconds ago");
    expect(formatRelativeActivity("2026-08-22T12:03:00.000Z", now)).toBe("2 minutes ago");
    expect(formatRelativeActivity("2026-08-22T10:05:00.000Z", now)).toBe("2 hours ago");
    expect(formatRelativeActivity("2026-08-20T12:05:00.000Z", now)).toBe("2 days ago");
  });

  test("orders transitions by stage, nests progress, and keeps warning and cleanup rows", () => {
    const indexing = transition(3, "uploading_to_gemini", "indexing");
    const fetching = transition(1, "queued", "fetching_context");
    const uploading = transition(2, "fetching_context", "uploading_to_gemini");
    const progress: AnalysisJobEvent = {
      jobId: fetching.jobId,
      attempt: 1,
      sequence: 4,
      kind: "progress",
      stage: "indexing",
      occurredAt: "2026-08-22T12:04:00.000Z",
      progress: { completed: 1, total: 2, unit: "items" },
      message: "First moment reviewed.",
    };
    const warning: AnalysisJobEvent = {
      jobId: fetching.jobId,
      attempt: 1,
      sequence: 5,
      kind: "warning",
      stage: "indexing",
      occurredAt: "2026-08-22T12:05:00.000Z",
      message: "One optional preview was unavailable.",
    };
    const cleanup: AnalysisJobEvent = {
      jobId: fetching.jobId,
      attempt: 1,
      sequence: 6,
      kind: "cleanup",
      stage: "cleaning_up",
      occurredAt: "2026-08-22T12:06:00.000Z",
      message: "Remote recording deleted.",
    };

    const rows = deriveActivityTimeline([
      indexing,
      warning,
      fetching,
      indexing,
      cleanup,
      progress,
      uploading,
    ]);
    expect(rows.filter((row) => row.type === "transition").map((row) => row.stage))
      .toEqual(["fetching_context", "uploading_to_gemini", "indexing"]);
    const indexingRow = rows.find((row) =>
      row.type === "transition" && row.stage === "indexing"
    );
    expect(indexingRow?.type === "transition" && indexingRow.progress).toEqual([{
      sequence: 4,
      occurredAt: "2026-08-22T12:04:00.000Z",
      label: "First moment reviewed.",
    }]);
    expect(rows.filter((row) => row.type === "notice").map((row) => row.type === "notice" && row.kind))
      .toEqual(["warning", "cleanup"]);
  });
});

class FakeRuntime implements JobActivityPollRuntime {
  isHidden = false;
  scheduled: Array<{ callback: () => void | Promise<void>; delay: number }> = [];
  visibility?: () => void;
  removed = false;

  hidden(): boolean { return this.isHidden; }
  schedule(callback: () => void | Promise<void>, delayMs: number): unknown {
    const entry = { callback, delay: delayMs };
    this.scheduled.push(entry);
    return entry;
  }
  cancel(handle: unknown): void {
    this.scheduled = this.scheduled.filter((entry) => entry !== handle);
  }
  listenVisibility(callback: () => void): () => void {
    this.visibility = callback;
    return () => {
      this.removed = true;
      this.visibility = undefined;
    };
  }
  async runNext(): Promise<void> {
    const next = this.scheduled.shift();
    if (next) await next.callback();
  }
}

describe("Studio Activity polling", () => {
  test("starts, backs off, pauses while hidden, resumes, and stops", async () => {
    const runtime = new FakeRuntime();
    const results = [
      { terminal: false, value: 1 },
      new Error("offline"),
      { terminal: false, value: 2 },
    ];
    const values: number[] = [];
    const notices: Array<string | undefined> = [];
    const poller = createJobActivityPoller({
      runtime,
      intervalMs: 3_000,
      load: async () => {
        const next = results.shift();
        if (next instanceof Error) throw next;
        if (!next) return { terminal: true, value: 3 };
        return next;
      },
      terminal: (result) => result.terminal,
      onData: (result) => values.push(result.value),
      onNotice: (message) => notices.push(message),
    });

    await poller.start();
    expect(values).toEqual([1]);
    expect(runtime.scheduled[0]?.delay).toBe(3_000);

    await runtime.runNext();
    expect(values).toEqual([1]);
    expect(notices.at(-1)).toBe("Activity could not refresh. Showing the last update.");
    expect(runtime.scheduled[0]?.delay).toBe(6_000);

    runtime.isHidden = true;
    runtime.visibility?.();
    expect(runtime.scheduled).toEqual([]);
    runtime.isHidden = false;
    runtime.visibility?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(values).toEqual([1, 2]);
    expect(runtime.scheduled[0]?.delay).toBe(3_000);

    poller.stop();
    expect(runtime.scheduled).toEqual([]);
    expect(runtime.removed).toBe(true);
  });

  test("stops scheduling at terminal state but explicit refresh keeps working", async () => {
    const runtime = new FakeRuntime();
    let value = 0;
    const poller = createJobActivityPoller({
      runtime,
      load: async () => ({ terminal: true, value: ++value }),
      terminal: (result) => result.terminal,
      onData: () => undefined,
      onNotice: () => undefined,
    });
    await poller.start();
    expect(runtime.scheduled).toEqual([]);
    runtime.visibility?.();
    await Promise.resolve();
    expect(value).toBe(1);
    await poller.refresh();
    expect(value).toBe(2);
    expect(runtime.scheduled).toEqual([]);
  });
});
