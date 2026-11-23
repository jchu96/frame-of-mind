import { afterEach, describe, expect, test, vi } from "vitest";
import {
  withHostedAccessTimeout,
} from "../scripts/hosted-access-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("hosted access timeout", () => {
  test("fails with the named wait and aborts the operation", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const pending = withHostedAccessTimeout(
      "better_auth_browser_login social_sign_in_request",
      (signal) => new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
      30_000,
    );

    const assertion = expect(pending).rejects.toThrow(
      "hosted_access_timeout: better_auth_browser_login social_sign_in_request",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(aborted).toBe(true);
  });

  test("preserves failures that happen before the deadline", async () => {
    await expect(withHostedAccessTimeout(
      "better_auth_browser_login callback_goto",
      async () => { throw new Error("callback rejected"); },
      30_000,
    )).rejects.toThrow("callback rejected");
  });
});
