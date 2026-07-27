import { MediaStagingError } from "./local-media-staging.js";

export const DEFAULT_MEDIA_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

interface ExpirableMediaStaging {
  expire(): Promise<readonly { status?: unknown }[]>;
}

export interface MediaExpirySweepFailure {
  code: string;
  count: number;
}

export interface MediaExpiryJanitor {
  sweep(): Promise<void>;
  stop(): Promise<void>;
}

export interface MediaExpiryJanitorOptions {
  intervalMs?: number;
  scheduleInterval?: (
    callback: () => void,
    intervalMs: number,
  ) => unknown;
  cancelInterval?: (handle: unknown) => void;
  onError?: (failure: MediaExpirySweepFailure) => void;
}

function sanitizedFailure(error: unknown): MediaExpirySweepFailure {
  if (
    error instanceof MediaStagingError
    && /^[a-z0-9_]+$/.test(error.code)
  ) {
    return { code: error.code, count: 1 };
  }
  return { code: "unknown", count: 1 };
}

function reportFailure(
  onError: (failure: MediaExpirySweepFailure) => void,
  failure: MediaExpirySweepFailure,
): void {
  try {
    onError(failure);
  } catch {
    // Error reporting must not disable future expiry sweeps.
  }
}

function releaseProcessOwnership(handle: unknown): void {
  if (
    handle
    && (typeof handle === "object" || typeof handle === "function")
    && "unref" in handle
    && typeof handle.unref === "function"
  ) {
    handle.unref();
  }
}

export function createMediaExpiryJanitor(
  staging: ExpirableMediaStaging,
  options: MediaExpiryJanitorOptions = {},
): MediaExpiryJanitor {
  const intervalMs = options.intervalMs
    ?? DEFAULT_MEDIA_EXPIRY_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("Media expiry sweep interval must be a positive integer.");
  }

  const scheduleInterval = options.scheduleInterval
    ?? ((callback, delay) => setInterval(callback, delay));
  const cancelInterval = options.cancelInterval
    ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const onError = options.onError ?? (() => {});
  let stopped = false;
  let activeSweep: Promise<void> | undefined;

  const sweep = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeSweep) return activeSweep;

    activeSweep = staging.expire()
      .then((sessions) => {
        const cleanupFailures = sessions.filter(
          (session) => session.status === "cleanup_failed",
        ).length;
        if (cleanupFailures > 0) {
          reportFailure(onError, {
            code: "cleanup_failed",
            count: cleanupFailures,
          });
        }
      })
      .catch((error: unknown) => {
        reportFailure(onError, sanitizedFailure(error));
      })
      .finally(() => {
        activeSweep = undefined;
      });
    return activeSweep;
  };

  const intervalHandle = scheduleInterval(() => {
    void sweep();
  }, intervalMs);
  releaseProcessOwnership(intervalHandle);

  return {
    sweep,
    async stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        cancelInterval(intervalHandle);
      }
      await activeSweep;
    },
  };
}
