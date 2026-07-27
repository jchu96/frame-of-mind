import { describe, expect, test } from "bun:test";
import {
  createContextExpiryJanitor,
} from "../server-local/studio-context/expiry-janitor";
import {
  ContextFileStagingError,
} from "../server-local/studio-context/local-context-staging";

describe("local context expiry janitor", () => {
  test("never overlaps and drains the active sweep during shutdown", async () => {
    let sweeps = 0;
    let finish = () => {};
    const janitor = createContextExpiryJanitor({
      expire() {
        sweeps += 1;
        return new Promise<string[]>((resolve) => {
          finish = () => resolve([]);
        });
      },
    }, { intervalMs: 60_000 });

    const first = janitor.sweep();
    const overlapping = janitor.sweep();
    expect(sweeps).toBe(1);
    const stopping = janitor.stop();
    finish();
    await Promise.all([first, overlapping, stopping]);

    await janitor.sweep();
    expect(sweeps).toBe(1);
  });

  test("reports only sanitized adapter codes and continues later sweeps", async () => {
    const failures: string[] = [];
    let sweeps = 0;
    const janitor = createContextExpiryJanitor({
      async expire() {
        sweeps += 1;
        if (sweeps === 1) {
          throw new ContextFileStagingError(
            "context_write_failed",
            "Could not remove /private/transcript.vtt.",
          );
        }
        if (sweeps === 2) {
          throw new Error("Unexpected /private/transcript.vtt failure.");
        }
        return [];
      },
    }, {
      intervalMs: 60_000,
      onError: (code) => failures.push(code),
    });

    await janitor.sweep();
    await janitor.sweep();
    await janitor.sweep();
    await janitor.stop();

    expect(sweeps).toBe(3);
    expect(failures).toEqual(["context_write_failed", "unknown"]);
    expect(JSON.stringify(failures)).not.toContain("transcript.vtt");
  });

  test("rejects a non-positive interval", () => {
    expect(() => createContextExpiryJanitor(
      { async expire() { return []; } },
      { intervalMs: 0 },
    )).toThrow(/positive integer/i);
  });
});
