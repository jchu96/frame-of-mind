export interface MapWithConcurrencyOptions<R> {
  /** No new item starts once this signal aborts; in-flight items settle. */
  signal?: AbortSignal;
  /**
   * Admission check before each new call. A false result retires this worker;
   * remaining in-flight workers still settle and commit, and may continue if
   * those commits reopen admission. Used to bound spending before an ordered
   * circuit-breaker decision can be made.
   */
  canStart?: () => boolean;
  /**
   * Called once per item, strictly in input order and never concurrently,
   * as soon as every earlier item has been committed. A worker waits for the
   * commits its own completion unlocked before starting another item, so at
   * `limit` 1 this is exactly a sequential map-then-commit loop.
   */
  onResult?: (result: R, index: number) => Promise<void> | void;
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight, returning
 * results in input order.
 *
 * The first rejection from `fn` or `onResult` stops new starts; in-flight
 * calls are awaited (never orphaned) before that error is rethrown. Callers
 * that need per-item failure isolation should return failures as values.
 * An aborted signal likewise stops new starts and, once in-flight calls
 * settle, rejects with the signal's reason unless every item already ran.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions<R> = {},
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Concurrency limit must be a positive integer.");
  }
  const { signal, onResult, canStart } = options;
  const results = new Array<R>(items.length);
  const finished = new Array<boolean>(items.length).fill(false);
  let nextIndex = 0;
  let committed = 0;
  let failure: { error: unknown } | undefined;
  let commits: Promise<void> = Promise.resolve();

  const commitReady = (): Promise<void> => {
    commits = commits.then(async () => {
      while (!failure && committed < items.length && finished[committed]) {
        const index = committed;
        await onResult!(results[index] as R, index);
        committed += 1;
      }
    });
    return commits;
  };

  const worker = async (): Promise<void> => {
    while (!failure && !signal?.aborted && nextIndex < items.length && (canStart?.() ?? true)) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await fn(items[index] as T, index);
        finished[index] = true;
        if (onResult) await commitReady();
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  if (failure) throw failure.error;
  if (finished.includes(false)) {
    throw signal?.reason ?? new Error("Operation was aborted.");
  }
  return results;
}
