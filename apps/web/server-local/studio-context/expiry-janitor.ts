import { ContextFileStagingError } from "./local-context-staging.js";

export const DEFAULT_CONTEXT_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

interface ExpirableContextStaging {
  expire(): Promise<readonly string[]>;
}

export interface ContextExpiryJanitor {
  sweep(): Promise<void>;
  stop(): Promise<void>;
}

export function createContextExpiryJanitor(
  staging: ExpirableContextStaging,
  options: {
    intervalMs?: number;
    onError?: (code: string) => void;
  } = {},
): ContextExpiryJanitor {
  const intervalMs = options.intervalMs
    ?? DEFAULT_CONTEXT_EXPIRY_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("Context expiry sweep interval must be a positive integer.");
  }
  let stopped = false;
  let active: Promise<void> | undefined;
  const sweep = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = staging.expire()
      .then(() => undefined)
      .catch((error: unknown) => {
        const code = error instanceof ContextFileStagingError
            && /^[a-z0-9_]+$/.test(error.code)
          ? error.code
          : "unknown";
        try {
          options.onError?.(code);
        } catch {
          // Reporting cannot disable future sweeps.
        }
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const timer = setInterval(() => {
    void sweep();
  }, intervalMs);
  timer.unref();
  return {
    sweep,
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await active;
    },
  };
}
