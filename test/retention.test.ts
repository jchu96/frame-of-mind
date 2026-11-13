import { describe, expect, it } from "vitest";
import { resolveRetention } from "../src/domain/retention.js";

describe("resolve", () => {
  it("--retention run beats FRAME_OF_MIND_UPLOAD_RETENTION=provider", () => {
    expect(resolveRetention({ retention: "run" }, "provider")).toBe("run");
  });
  it.each([
    [{}, undefined, "provider"], [{}, "run", "run"],
    [{ retention: "provider" }, "run", "provider"],
    [{ keepUpload: true }, "run", "provider"],
    [{ deleteUpload: true }, "provider", "run"],
  ] as const)("resolves flags %j and environment %s to %s", (flags, env, expected) => {
    expect(resolveRetention(flags, env)).toBe(expected);
  });
  it.each(["", "idle:2h", "forever", "RUN"])("rejects invalid retention %s", (value) => {
    expect(() => resolveRetention({ retention: value })).toThrow("Upload retention must be");
    expect(() => resolveRetention({}, value)).toThrow("Upload retention must be");
  });
  it("refuses conflicting explicit aliases", () => {
    expect(() => resolveRetention({ keepUpload: true, deleteUpload: true })).toThrow();
    expect(() => resolveRetention({ retention: "run", keepUpload: true })).toThrow();
  });
});
