import { describe, expect, it } from "vitest";
import { runFailureManifestSchema } from "../src/domain/run-failure.js";

const baseFailure = {
  schemaVersion: 1 as const,
  toolVersion: "0.3.0",
  runId: "synthetic-failure",
  status: "failed" as const,
  phase: "detail" as const,
  startedAt: "2026-07-28T12:00:00.000Z",
  failedAt: "2026-07-28T12:01:00.000Z",
  recipe: {
    id: "issue-review",
    revision: "synthetic",
    sha256: "a".repeat(64),
  },
  model: "gemini-test",
  recordingSha256: "b".repeat(64),
  error: { code: "unexpected_failure" as const },
};

describe("run failure manifest", () => {
  it("rejects reversed chronology and provider payload-shaped expiration metadata", () => {
    expect(() => runFailureManifestSchema.parse({
      ...baseFailure,
      failedAt: "2026-07-28T11:59:00.000Z",
      remoteFile: {
        name: "files/synthetic",
        expirationTime: "private-provider-payload",
        cleanup: "unconfirmed",
      },
    })).toThrow();
  });

  it("requires exact identity for confirmed or intentionally retained cleanup", () => {
    for (const cleanup of ["confirmed_deleted", "intentionally_retained"] as const) {
      expect(() => runFailureManifestSchema.parse({
        ...baseFailure,
        remoteFile: { cleanup },
      })).toThrow();
    }
  });

  it("represents an upload that never obtained a remote identity", () => {
    expect(runFailureManifestSchema.parse({
      ...baseFailure,
      phase: "upload",
      remoteFile: { cleanup: "not_obtained" },
    }).remoteFile.cleanup).toBe("not_obtained");
  });
});
