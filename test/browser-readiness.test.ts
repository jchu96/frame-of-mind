import { describe, expect, it, vi } from "vitest";
import {
  isBrowserDisconnect,
  retryBrowserReadiness,
} from "../scripts/browser-readiness";

describe("browser readiness recovery", () => {
  it("retries the hub's pre-auth Chromium disconnect exactly once", async () => {
    const attempt = vi.fn(async (number: number) => {
      if (number === 1) {
        throw new Error("goto: Target page, context or browser has been closed");
      }
      return "ready";
    });
    const onRetry = vi.fn();

    await expect(retryBrowserReadiness(attempt, onRetry)).resolves.toBe("ready");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }));
  });

  it("does not relabel an HTTP or auth failure as a browser disconnect", async () => {
    const error = new Error("goto: net::ERR_CONNECTION_REFUSED");
    const attempt = vi.fn(async () => { throw error; });

    expect(isBrowserDisconnect(error)).toBe(false);
    await expect(retryBrowserReadiness(attempt)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("surfaces a second browser disconnect", async () => {
    const error = new Error("Target closed");
    const attempt = vi.fn(async () => { throw error; });

    await expect(retryBrowserReadiness(attempt)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
