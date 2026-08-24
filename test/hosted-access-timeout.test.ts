import { afterEach, describe, expect, test, vi } from "vitest";
import {
  resolveHostedAccessStepTimeoutSeconds,
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

  test("caps only the Better Auth hosted-access lane step", () => {
    expect(resolveHostedAccessStepTimeoutSeconds(
      "test:hosted-access-http:better-auth",
      1_800,
      300,
    )).toBe(300);
    expect(resolveHostedAccessStepTimeoutSeconds(
      "test:hosted-workflows-http:better-auth",
      1_800,
      300,
    )).toBe(1_800);
    expect(resolveHostedAccessStepTimeoutSeconds(
      "test:hosted-access-http:better-auth",
      120,
      300,
    )).toBe(120);
  });
});
