export interface BrowserReadinessRetry {
  readonly attempt: number;
  readonly error: Error;
}

export function isBrowserDisconnect(error: unknown): error is Error {
  return error instanceof Error
    && /target page, context or browser has been closed|browser has been closed|target closed|connection terminated while reading from pipe|could not write into pipe/i.test(error.message);
}

export async function retryBrowserReadiness<T>(
  attemptReadiness: (attempt: number) => Promise<T>,
  onRetry?: (retry: BrowserReadinessRetry) => void,
): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await attemptReadiness(attempt);
    } catch (error) {
      if (!isBrowserDisconnect(error) || attempt === 2) throw error;
      onRetry?.({ attempt, error });
    }
  }
  throw new Error("Browser readiness retry exhausted without an outcome.");
}
