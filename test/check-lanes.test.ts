import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  PREBUILT_OUTPUT_ENV,
  PrebuiltPresetMismatchError,
  resolvePrebuiltWebOutput,
  writeBuildMarker,
} from "../scripts/prebuilt-artifact";
import { killOwnedProcessGroup, runTimedProcess } from "../scripts/check-process";
import { isHostedSensitivePath } from "../scripts/check-gate-policy";

const originalPrebuiltOutput = process.env[PREBUILT_OUTPUT_ENV];

afterEach(() => {
  if (originalPrebuiltOutput === undefined) {
    delete process.env[PREBUILT_OUTPUT_ENV];
  } else {
    process.env[PREBUILT_OUTPUT_ENV] = originalPrebuiltOutput;
  }
});

describe("check lanes", () => {
  test("cover exactly the same logical steps as serial check", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const serialSteps = packageJson.scripts.check
      .split(" && ")
      .map((command) => command.match(/^bun run ([a-z0-9:-]+)$/)?.[1])
      .filter((step): step is string => Boolean(step));
    const laneSteps = [
      ...parseRunnerSteps(packageJson.scripts["check:lane:fast"], "fast"),
      ...parseRunnerSteps(packageJson.scripts["check:lane:local"], "local"),
      ...parseRunnerSteps(packageJson.scripts["check:lane:hosted"], "hosted"),
    ];

    expect(serialSteps).toHaveLength(16);
    expect(new Set(laneSteps).size).toBe(laneSteps.length);
    expect([...laneSteps].sort()).toEqual([...serialSteps].sort());
  });

  test("fails closed when a cloudflare consumer receives a node artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "frame-of-mind-prebuilt-test-"));
    try {
      await writeBuildMarker(root, "node-server");
      process.env[PREBUILT_OUTPUT_ENV] = root;
      await expect(resolvePrebuiltWebOutput("cloudflare_module")).rejects.toMatchObject({
        code: "prebuilt_preset_mismatch",
      } satisfies Partial<PrebuiltPresetMismatchError>);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("upgrades the PR tier only for hosted-sensitive paths", () => {
    expect([
      "apps/web/server-hosted/repository.ts",
      "apps/workflows/src/index.ts",
      "scripts/test-hosted-media-http.ts",
      "apps/web/db/migrations/0009_example.sql",
    ].every(isHostedSensitivePath)).toBe(true);
    expect([
      "apps/web/server-local/repository.ts",
      "scripts/run-check-sharded.ts",
      "test/check-lanes.test.ts",
    ].some(isHostedSensitivePath)).toBe(false);
  });

  test("terminates only its detached step group at the hard timeout", async () => {
    const unrelated = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ], {
      detached: true,
      stdio: "ignore",
    });
    const startedAt = performance.now();
    try {
      const result = await runTimedProcess([
        "bun",
        "-e",
        "setInterval(() => {}, 1000)",
      ], {
        cwd: process.cwd(),
        env: process.env,
        timeoutSeconds: 1,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result).toEqual({ exitCode: 124, timedOut: true });
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(unrelated.exitCode).toBeNull();
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      killOwnedProcessGroup(unrelated, "SIGKILL");
    }
  });
});

function parseRunnerSteps(command: string, lane: string): string[] {
  const prefix = `bun scripts/run-check-lane.ts ${lane} `;
  expect(command.startsWith(prefix)).toBe(true);
  return command.slice(prefix.length).trim().split(/\s+/);
}
