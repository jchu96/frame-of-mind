import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import type { Case, EntryCase } from "./time-contract-oracle.js";

const table = JSON.parse(readFileSync(new URL("../docs/contracts/time-cases.json", import.meta.url), "utf8")) as { cases: Case[]; entryCases: EntryCase[] };

function unavailableExports(names: string[], module: string) {
  const exports = Object.create(null);
  for (const name of names) Object.defineProperty(exports, name, {
    enumerable: true,
    get() { throw new Error(`MISS D10: production module called from the oracle: ${module}.${name}`); },
  });
  return exports;
}

test("the oracle recomputes every table row with production modules unavailable", async () => {
  // Discover runtime exports, including constants and schemas, before isolating the oracle.
  const exactNames = Object.keys(await vi.importActual("../src/domain/exact-time.js"));
  const rateNames = Object.keys(await vi.importActual("../src/domain/time-rate.js"));
  vi.resetModules();
  vi.doMock("../src/domain/exact-time.js", () => unavailableExports(exactNames, "exact-time"));
  vi.doMock("../src/domain/time-rate.js", () => unavailableExports(rateNames, "time-rate"));
  try {
    // Verify the runtime boundary itself: every export is poisoned, not just known functions.
    const exact = await import("../src/domain/exact-time.js");
    const rate = await import("../src/domain/time-rate.js");
    for (const name of exactNames) expect(() => Reflect.get(exact, name)).toThrow("production module called from the oracle");
    for (const name of rateNames) expect(() => Reflect.get(rate, name)).toThrow("production module called from the oracle");

    const { oracle, oracleRefusal, entryOracle } = await import("./time-contract-oracle.js");
    let completed = 0;
    for (const row of table.cases) {
      if (row.refused) expect(oracleRefusal(row), row.id).toBe(row.refused);
      else expect(oracle(row), row.id).toEqual(row.expected);
      completed++;
    }
    for (const row of table.entryCases) {
      expect(entryOracle(row), row.id).toEqual(row.refused ?? row.expected);
      completed++;
    }
    const total = table.cases.length + table.entryCases.length;
    expect(completed).toBe(total);
    process.stdout.write(`independent oracle completed ${completed} of ${total}\n`);
  } finally {
    vi.doUnmock("../src/domain/exact-time.js");
    vi.doUnmock("../src/domain/time-rate.js");
    vi.resetModules();
  }
});
