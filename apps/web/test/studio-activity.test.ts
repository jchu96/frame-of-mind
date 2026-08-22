import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type {
  AnalysisJob,
  AnalysisJobEvent,
} from "../../../src/domain/studio-schemas";
import {
  activityDisplayState,
  activityGroupForStage,
  activityStageChangeAnnouncement,
  deriveActivityTimeline,
  formatRelativeActivity,
  groupActivityJobs,
} from "../server-local/studio-ui/activity-state";
import { deriveActivityProgress } from "../server-local/studio-ui/activity-progress";
import {
  activityListTerminal,
  createJobActivityTransport,
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
      retention: {
        mode: "ephemeral",
        expiresAt: "2026-08-22T13:00:00.000Z",
      },
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
    expect(formatRelativeActivity("2026-08-22T12:06:00.000Z", now)).toBe("just now");
  });

  test("derives honest elapsed and stage progress for every job stage without progress events", () => {
    const activeStages = [
      "queued",
      "fetching_context",
      "uploading_to_gemini",
      "indexing",
      "interrogating",
      "rendering",
      "cleaning_up",
    ] as const;

    for (const [index, stage] of activeStages.entries()) {
      const current = job(stage);
      const transitionEvent = stage === "queued"
        ? []
        : [transition(index + 1, activeStages[Math.max(0, index - 1)]!, stage)];
      const progress = deriveActivityProgress(
        current,
        transitionEvent,
        "2026-08-22T12:10:12.000Z",
      );

      expect(progress.elapsed).toEqual({
        seconds: 612,
        text: "10m 12s",
        accessibleText: "10 minutes 12 seconds elapsed",
      });
      expect(progress.currentStageStartedAt).toBe(
        stage === "queued" ? current.createdAt : transitionEvent[0]!.occurredAt,
      );
      expect(progress.descriptor).toEqual({
        kind: "indeterminate",
        text: "In progress",
        detail: `Step ${index + 1} of 7`,
        accessibleText: `In progress, step ${index + 1} of 7`,
      });
    }

    for (const stage of ["succeeded", "failed", "canceled", "interrupted"] as const) {
      const current = job(stage);
      const terminal = transition(7, "cleaning_up", stage);
      const progress = deriveActivityProgress(
        current,
        [terminal],
        "2026-08-22T13:10:12.000Z",
      );
      expect(progress.elapsed.seconds).toBe(420);
      expect(progress.currentStageStartedAt).toBe(terminal.occurredAt);
      expect(progress.descriptor.kind).toBe("terminal");
      expect(progress.descriptor.text).toBe(
        stage === "succeeded"
          ? "Completed"
          : stage === "failed"
            ? "Failed"
            : stage === "canceled"
              ? "Canceled"
              : "Interrupted",
      );
    }
  });

  test("renders counted item and byte progress without inventing a percentage", () => {
    const current = job("interrogating");
    const stageEvent = transition(4, "indexing", "interrogating");
    const itemProgress: AnalysisJobEvent = {
      jobId: current.id,
      attempt: 1,
      sequence: 5,
      kind: "progress",
      stage: "interrogating",
      occurredAt: "2026-08-22T12:05:30.000Z",
      progress: { completed: 3, total: 8, unit: "items" },
      message: "Reviewed candidate 3.",
    };
    const counted = deriveActivityProgress(
      current,
      [stageEvent, itemProgress],
      "2026-08-22T12:10:00.000Z",
    );

    expect(counted.lastActivityAt).toBe(itemProgress.occurredAt);
    expect(counted.lastActivityText).toBe("4 minutes ago");
    expect(counted.descriptor).toEqual({
      kind: "determinate",
      text: "3 of 8",
      detail: "Step 5 of 7",
      accessibleText: "3 of 8 items, step 5 of 7",
      completed: 3,
      total: 8,
    });
    expect(counted.descriptor.text).not.toContain("%");

    const byteProgress: AnalysisJobEvent = {
      ...itemProgress,
      stage: "uploading_to_gemini",
      progress: { completed: 1_500_000, total: 4_000_000, unit: "bytes" },
    };
    const upload = deriveActivityProgress(
      job("uploading_to_gemini"),
      [transition(2, "fetching_context", "uploading_to_gemini"), byteProgress],
      "2026-08-22T12:10:00.000Z",
    );
    expect(upload.descriptor).toEqual({
      kind: "determinate",
      text: "1.5 MB of 4 MB",
      detail: "Step 3 of 7",
      accessibleText: "1.5 megabytes of 4 megabytes, step 3 of 7",
      completed: 1_500_000,
      total: 4_000_000,
    });

    // Rounding must never make an incomplete transfer read as complete.
    const nearlyDone = deriveActivityProgress(
      job("uploading_to_gemini"),
      [
        transition(2, "fetching_context", "uploading_to_gemini"),
        { ...byteProgress, progress: { completed: 4_950_000, total: 5_000_000, unit: "bytes" } },
      ],
      "2026-08-22T12:10:00.000Z",
    );
    expect(nearlyDone.descriptor.text).toBe("4.95 MB of 5 MB");
    expect(nearlyDone.descriptor.text).not.toBe("5 MB of 5 MB");
  });

  test("freezes terminal elapsed at the transition and clamps future activity", () => {
    const terminal = transition(7, "cleaning_up", "succeeded");
    const futureWarning: AnalysisJobEvent = {
      jobId: terminal.jobId,
      attempt: 1,
      sequence: 8,
      kind: "warning",
      stage: "succeeded",
      occurredAt: "2026-08-22T12:12:00.000Z",
      message: "Synthetic skew.",
    };
    const progress = deriveActivityProgress(
      job("succeeded"),
      [terminal, futureWarning],
      "2026-08-22T12:10:00.000Z",
    );

    expect(progress.elapsed).toEqual({
      seconds: 420,
      text: "7m",
      accessibleText: "7 minutes elapsed",
    });
    expect(progress.lastActivityAt).toBe(futureWarning.occurredAt);
    expect(progress.lastActivityText).toBe("just now");
  });

  test("announces a stage change once and stays silent on an unchanged poll", () => {
    const queued = job("queued");
    const indexing = job("indexing", queued.id);
    expect(activityStageChangeAnnouncement([], [queued])).toBeUndefined();
    expect(activityStageChangeAnnouncement([queued], [indexing])).toBe(
      "Requirements moved to Finding relevant moments.",
    );
    expect(activityStageChangeAnnouncement([indexing], [indexing])).toBeUndefined();
  });

  test("renders elapsed and honest progress in Activity rows", async () => {
    const source = await readFile(
      new URL("../server-local/studio-ui/activity.vue", import.meta.url),
      "utf8",
    );

    expect(source).toContain('data-activity-elapsed');
    expect(source).toContain('jobProgress(job).elapsed.accessibleText');
    expect(source).toContain('jobProgress(job).lastActivityText');
    expect(source).toContain('jobProgress(job).descriptor.kind === \'determinate\'');
    expect(source).toContain('role="progressbar"');
    expect(source).toContain(':aria-valuenow="jobProgress(job).descriptor.completed"');
    expect(source).toContain(':aria-valuemax="jobProgress(job).descriptor.total"');
  });

  test("renders timing and terminal-freeze metadata in Activity detail", async () => {
    const source = await readFile(
      new URL("../server-local/studio-ui/activity-detail.vue", import.meta.url),
      "utf8",
    );

    expect(source).toContain('data-activity-progress="honest"');
    expect(source).toContain(':data-elapsed-seconds="activityProgress.elapsed.seconds"');
    expect(source).toContain(
      ':data-terminal="activityProgress.descriptor.kind === \'terminal\'"',
    );
    expect(source).toContain('activityProgress.elapsed.accessibleText');
    expect(source).toContain('activityProgress.lastActivityText');
    expect(source).toContain('activityProgress.currentStageStartedAt');
    expect(source).toContain("activityProgress.descriptor.kind === 'determinate'");
    expect(source).toContain(':aria-valuenow="activityProgress.descriptor.completed"');
    expect(source).toContain(':aria-valuemax="activityProgress.descriptor.total"');
  });

  test("orders transitions and keeps cancellation, warning, and cleanup rows", () => {
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
      sequence: 6,
      kind: "warning",
      stage: "indexing",
      occurredAt: "2026-08-22T12:05:00.000Z",
      message: "One optional preview was unavailable.",
    };
    const cancellationRequested: AnalysisJobEvent = {
      jobId: fetching.jobId,
      attempt: 1,
      sequence: 5,
      kind: "cancellation_requested",
      stage: "indexing",
      occurredAt: "2026-08-22T12:05:00.000Z",
      message: "Cancellation requested by the operator.",
    };
    const cleanup: AnalysisJobEvent = {
      jobId: fetching.jobId,
      attempt: 1,
      sequence: 7,
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
      cancellationRequested,
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
      .toEqual(["cancellation_requested", "warning", "cleanup"]);
  });
});

describe("Studio Activity transport", () => {
  test("loads every detail page in sequence and strips additive event fields", async () => {
    const detailJob = job("queued", "job_01K123456789ABC");
    const sourceEvents = Array.from({ length: 201 }, (_, index) => {
      const sequence = index + 1;
      return {
        jobId: detailJob.id,
        attempt: 1,
        sequence,
        kind: "warning" as const,
        stage: "queued" as const,
        occurredAt: "2026-08-22T12:01:00.000Z",
        message: `Warning ${sequence}.`,
        ...(sequence === 101
          ? {
              code: "provider_raw_code",
              futureField: "future_additive_value",
            }
          : {}),
      };
    });
    const pages = [
      { job: detailJob, events: sourceEvents.slice(0, 100), nextAfterSequence: 100 },
      { job: detailJob, events: sourceEvents.slice(100, 200), nextAfterSequence: 200 },
      { job: detailJob, events: sourceEvents.slice(200) },
    ];
    const requests: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      const page = pages.shift();
      if (!page) return new Response(null, { status: 500 });
      return Response.json(page);
    }) as typeof fetch;

    const detail = await createJobActivityTransport(fakeFetch).detail(detailJob.id);

    expect(requests).toEqual([
      `/api/studio/jobs/${detailJob.id}?limit=100`,
      `/api/studio/jobs/${detailJob.id}?limit=100&after=100`,
      `/api/studio/jobs/${detailJob.id}?limit=100&after=200`,
      `/api/studio/media/${detailJob.input.mediaSessionId}`,
    ]);
    expect(detail.actionSnapshot).toEqual({
      media: undefined,
      projection: "unknown",
    });
    expect(detail.events.map((event) => event.sequence)).toEqual(
      sourceEvents.map((event) => event.sequence),
    );
    expect(detail.events).toHaveLength(201);
    expect("futureField" in detail.events[100]!).toBe(false);
    const warningMessages = deriveActivityTimeline(detail.events)
      .filter((row) => row.type === "notice")
      .map((row) => row.message);
    expect(warningMessages).toEqual(sourceEvents.map((event) => event.message));
    expect(warningMessages.join(" ")).not.toContain("provider_raw_code");
    expect(warningMessages.join(" ")).not.toContain("future_additive_value");
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
  test("keeps an empty or terminal list live until a new job appears", async () => {
    const runtime = new FakeRuntime();
    const pages = [
      { jobs: [] },
      { jobs: [job("failed")] },
      { jobs: [job("queued", "job_from_another_window")] },
    ];
    const observedIds: string[][] = [];
    const poller = createJobActivityPoller({
      runtime,
      intervalMs: 3_000,
      load: async () => pages.shift() ?? { jobs: [] },
      terminal: activityListTerminal,
      onData: (page) => observedIds.push(page.jobs.map((item) => item.id)),
      onNotice: () => undefined,
    });

    await poller.start();
    expect(observedIds).toEqual([[]]);
    expect(runtime.scheduled[0]?.delay).toBe(3_000);
    await runtime.runNext();
    expect(observedIds).toEqual([[], ["job_failed"]]);
    expect(runtime.scheduled[0]?.delay).toBe(3_000);
    await runtime.runNext();
    expect(observedIds.at(-1)).toEqual(["job_from_another_window"]);
    expect(runtime.scheduled[0]?.delay).toBe(3_000);

    poller.stop();
  });

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
