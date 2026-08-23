import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { test, expect } from "@playwright/test";
import { createE2EEnvironment } from "../../../../scripts/e2e-environment";

// REVIEW-fom-spike20.md and REVIEW-fom-spike20-r2.md: the dark spike oracle
// owns the slow-sink, over-length truncation, and short-part failure probes.
test("@adversarial hosted upload spike keeps all recurring byte probes green", async () => {
  test.skip(
    !existsSync("scripts/spike-hosted-entry.ts")
      || !existsSync("scripts/spike-hosted-streaming.ts"),
    "Hosted streaming spike entry is absent on this base.",
  );
  const child = spawn("bun", ["--no-env-file", "run", "check:hosted-stream"], {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  expect(exitCode, stderr.slice(0, 4_000)).toBe(0);
  expect(stdout).toContain("HOSTED_STREAM slow_sink=PASS");
  expect(stdout).toContain("HOSTED_STREAM over_length_truncation=PASS");
  expect(stdout).toContain("HOSTED_STREAM short_part=PASS");
});
