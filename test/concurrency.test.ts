import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/lib/concurrency.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("mapWithConcurrency", () => {
  it("returns results and commits in input order when calls finish out of order", async () => {
    const gates = [0, 1, 2, 3, 4].map(() => deferred<void>());
    const committed: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4], 3, async (item) => {
      await gates[item]!.promise;
      return item * 10;
    }, { onResult: (result, index) => { committed.push(index); expect(result).toBe(index * 10); } });

    for (const item of [2, 1, 4, 3, 0]) {
      gates[item]!.resolve();
      await flush();
    }

    await expect(run).resolves.toEqual([0, 10, 20, 30, 40]);
    expect(committed).toEqual([0, 1, 2, 3, 4]);
  });

  it("never exceeds the limit of in-flight calls", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      3,
      async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, (item * 7) % 5));
        inFlight -= 1;
        return item;
      },
    );
    expect(maxInFlight).toBe(3);
    expect(results).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it("behaves as a sequential call-then-commit loop at limit 1", async () => {
    const log: string[] = [];
    await mapWithConcurrency([0, 1, 2], 1, async (item) => {
      log.push(`call ${item}`);
      return item;
    }, { onResult: async (_result, index) => { log.push(`commit ${index}`); } });
    expect(log).toEqual(["call 0", "commit 0", "call 1", "commit 1", "call 2", "commit 2"]);
  });

  it("isolates failures returned as values and stops new starts on a thrown error", async () => {
    const isolated = await mapWithConcurrency([0, 1, 2], 2, async (item) =>
      item === 1 ? { error: "candidate" } : { value: item });
    expect(isolated).toEqual([{ value: 0 }, { error: "candidate" }, { value: 2 }]);

    const started: number[] = [];
    const slow = deferred<void>();
    let slowSettled = false;
    const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      if (item === 0) {
        await slow.promise;
        slowSettled = true;
        return item;
      }
      throw new Error(`boom ${item}`);
    });
    await flush();
    expect(started).toEqual([0, 1]);
    let rejected = false;
    void run.catch(() => { rejected = true; });
    await flush();
    // The in-flight call is awaited before the error surfaces.
    expect(rejected).toBe(false);
    slow.resolve();
    await expect(run).rejects.toThrow("boom 1");
    expect(slowSettled).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it("stops starting new items after abort and lets in-flight items settle", async () => {
    const controller = new AbortController();
    const gates = [0, 1, 2, 3].map(() => deferred<void>());
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      await gates[item]!.promise;
      return item;
    }, { signal: controller.signal });
    await flush();
    controller.abort(new Error("canceled"));
    gates[0]!.resolve();
    gates[1]!.resolve();
    await expect(run).rejects.toThrow("canceled");
    expect(started).toEqual([0, 1]);
  });

  it("propagates a commit failure and stops new starts", async () => {
    const started: number[] = [];
    await expect(mapWithConcurrency([0, 1, 2, 3], 1, async (item) => {
      started.push(item);
      return item;
    }, {
      onResult: (_result, index) => {
        if (index === 1) throw new Error("breaker");
      },
    })).rejects.toThrow("breaker");
    expect(started).toEqual([0, 1]);
  });

  it("rejects an invalid limit and handles empty input", async () => {
    await expect(mapWithConcurrency([1], 0, async (item) => item)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([], 4, async (item: number) => item)).resolves.toEqual([]);
  });
});
