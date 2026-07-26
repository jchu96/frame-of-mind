import { describe, expect, it } from "vitest";
import { assertEvidenceWithinCandidate } from "../src/services/analyze.js";

describe("analysis evidence validation", () => {
  it("rejects model evidence outside the indexed clip", () => {
    expect(() => assertEvidenceWithinCandidate(
      "00:00:09",
      "00:00:10",
      "00:00:20",
    )).toThrow(/outside/);
    expect(() => assertEvidenceWithinCandidate(
      "00:00:15",
      "00:00:10",
      "00:00:20",
    )).not.toThrow();
  });
});
