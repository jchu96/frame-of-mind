import { describe, expect, test } from "bun:test";
import { runImportSchema } from "../../../src/domain/schemas";
import { runFixture } from "./fixtures";

describe("run import contract", () => {
  test("accepts a matching analysis and manifest", () => {
    expect(runImportSchema.parse(runFixture()).manifest.runId).toContain("test");
  });

  test("rejects mismatched meeting identity", () => {
    const input = runFixture();
    input.manifest.meetingId = "another-meeting";
    expect(runImportSchema.safeParse(input).success).toBe(false);
  });
});
