import { describe, expect, test } from "bun:test";
import {
  createMediaExpiryJanitor,
  DEFAULT_MEDIA_EXPIRY_SWEEP_INTERVAL_MS,
} from "../server-local/studio-media/expiry-janitor";
import { MediaStagingError } from
  "../server-local/studio-media/local-media-staging";

interface ControlledScheduler {
  callback: () => void;
  cancelled: boolean;
  delay: number;
  unreferenced: boolean;
}

function controlledScheduler() {
  const state: ControlledScheduler = {
    callback: () => {},
    cancelled: false,
    delay: 0,
    unreferenced: false,
  };
  return {
    state,
    scheduleInterval(callback: () => void, delay: number) {
      state.callback = callback;
      state.delay = delay;
      return {
        unref() {
          state.unreferenced = true;
        },
      };
    },
    cancelInterval() {
      state.cancelled = true;
    },
  };
}

describe("local media expiry janitor", () => {
  test("schedules an unreferenced periodic expiry sweep", async () => {
    const scheduler = controlledScheduler();
    let sweeps = 0;
    const janitor = createMediaExpiryJanitor(
      {
        async expire() {
          sweeps += 1;
          return [];
        },
      },
      scheduler,
    );

    expect(scheduler.state.delay).toBe(
      DEFAULT_MEDIA_EXPIRY_SWEEP_INTERVAL_MS,
    );
    expect(scheduler.state.unreferenced).toBe(true);
    scheduler.state.callback();
    await Promise.resolve();
    expect(sweeps).toBe(1);

    await janitor.stop();
    expect(scheduler.state.cancelled).toBe(true);
  });

  test("never overlaps sweeps and waits for the active sweep on stop", async () => {
    const scheduler = controlledScheduler();
    let sweeps = 0;
    let finishSweep = () => {};
    const janitor = createMediaExpiryJanitor(
      {
        expire() {
          sweeps += 1;
          return new Promise<[]>((resolve) => {
            finishSweep = () => resolve([]);
          });
        },
      },
      scheduler,
    );

    const first = janitor.sweep();
    const overlapping = janitor.sweep();
    scheduler.state.callback();
    expect(sweeps).toBe(1);

    const stopping = janitor.stop();
    expect(scheduler.state.cancelled).toBe(true);
    expect(sweeps).toBe(1);
    finishSweep();
    await Promise.all([first, overlapping, stopping]);

    await janitor.sweep();
    scheduler.state.callback();
    expect(sweeps).toBe(1);
  });

  test("reports only a sanitized failure code and keeps sweeping", async () => {
    const scheduler = controlledScheduler();
    const failures: Array<{ code: string; count: number }> = [];
    let sweeps = 0;
    const janitor = createMediaExpiryJanitor(
      {
        async expire() {
          sweeps += 1;
          if (sweeps === 1) {
            throw new MediaStagingError(
              "cleanup_failed",
              "Could not remove /private/recording.mp4.",
            );
          }
          if (sweeps === 2) {
            throw new Error("Unexpected /private/recording.mp4 failure.");
          }
          return [];
        },
      },
      {
        ...scheduler,
        onError: (failure) => failures.push(failure),
      },
    );

    await janitor.sweep();
    await janitor.sweep();
    await janitor.sweep();

    expect(sweeps).toBe(3);
    expect(failures).toEqual([
      { code: "cleanup_failed", count: 1 },
      { code: "unknown", count: 1 },
    ]);
    expect(JSON.stringify(failures)).not.toContain("recording.mp4");
    await janitor.stop();
  });

  test("reports cleanup failures returned by the adapter", async () => {
    const scheduler = controlledScheduler();
    const failures: Array<{ code: string; count: number }> = [];
    const janitor = createMediaExpiryJanitor(
      {
        async expire() {
          return [
            { status: "cleanup_failed" },
            { status: "deleted" },
            { status: "cleanup_failed" },
          ];
        },
      },
      {
        ...scheduler,
        onError: (failure) => failures.push(failure),
      },
    );

    await janitor.sweep();
    expect(failures).toEqual([{ code: "cleanup_failed", count: 2 }]);
    await janitor.stop();
  });

  test("rejects invalid intervals", () => {
    expect(() => createMediaExpiryJanitor(
      { async expire() { return []; } },
      { intervalMs: 0 },
    )).toThrow(/positive integer/i);
  });
});
