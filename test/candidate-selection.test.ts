import { expect, it } from "vitest";
import { selectCandidates } from "../src/domain/candidate-selection.js";
import type { IndexedMoment } from "../src/domain/types.js";
const moments: IndexedMoment[] = Array.from({ length: 57 }, (_, i) => ({
  start: `00:00:${String(i).padStart(2, "0")}`, end: `00:00:${String(i + 1).padStart(2, "0")}`,
  summary: "Synthetic candidate", kind: "observation", importance: i >= 50 ? "high" : i >= 20 ? "medium" : "low",
}));
it("every high-importance moment is chosen before any medium", () => {
  const selected = selectCandidates(moments, 10);
  expect(selected).toHaveLength(10);
  expect(selected.filter(m => m.importance === "high")).toEqual(moments.slice(50));
  expect(selected.filter(m => m.importance === "medium")).toEqual(moments.slice(20, 23));
  expect(selected.some(m => m.importance === "low")).toBe(false);
});
it("selected moments are returned in start-time order", () => {
  const selected = selectCandidates(moments, 10);
  expect(selected.map(m => m.start)).toEqual([20,21,22,50,51,52,53,54,55,56].map(i => `00:00:${i}`));
  expect(moments[0]!.importance).toBe("low");
});
