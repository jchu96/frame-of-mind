import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
const capture = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/telemetry.js", () => ({
  captureCliException: capture,
  cliAnalysisTracer: () => undefined,
  flushCliTelemetry: async () => undefined,
  isCliTelemetryEnabled: () => false,
}));
afterEach(() => vi.unstubAllEnvs());
it("the telemetry version equals the package version", async () => {
  const { program } = await import("../src/cli.js");
  vi.stubEnv("GEMINI_API_KEY", "synthetic-key");
  await expect(program.parseAsync(["node", "cli", "analyze", "--source", "none", "--video", "package.json", "--max-moments", "invalid"]))
    .rejects.toThrow("positive integer");
  expect(capture).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    version: JSON.parse(readFileSync("package.json", "utf8")).version,
  }));
});
