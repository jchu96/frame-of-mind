import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  buildContentHash,
  isBuildInputPath,
  scrubBuildEnvironment,
} from "../scripts/check-build-cache";
import {
  isPrSafePath,
  isThemeContractPath,
  selectGateTier,
} from "../scripts/check-gate-policy";

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

  test("keeps PR tier only when every changed path is explicitly safe", () => {
    const safePaths = [
      "docs/x.md",
      "README.md",
      "conductor/tracks/example/spec.json",
      "test/check-lanes.test.ts",
      "apps/web/app/components/Callout.vue",
      "apps/web/app/assets/logo.svg",
    ];
    expect(safePaths.every(isPrSafePath)).toBe(true);
    expect(selectGateTier("pr", true, safePaths)).toEqual({
      tier: "pr",
      reason: "all_paths_safe",
    });

    for (const path of [
      "src/domain/studio-schemas.ts",
      "apps/web/server-hosted/foo.ts",
      "apps/web/server/middleware/00.auth.ts",
      "apps/workflows/src/index.ts",
      "scripts/test-hosted-media-http.ts",
      "apps/web/db/migrations/0009_example.sql",
      "apps/web/nuxt.config.ts",
      ".github/workflows/ci.yml",
      "package.json",
      "bun.lock",
    ]) {
      expect(selectGateTier("pr", true, [path]), path).toEqual({
        tier: "sharded",
        reason: "unsafe_path",
      });
    }
  });

  test("upgrades theme contract paths to the hosted sharded tier", () => {
    for (const path of [
      "apps/web/app/assets/css/main.css",
      "apps/web/app/assets/css/tokens.scss",
      "apps/web/app.config.ts",
    ]) {
      expect(isThemeContractPath(path), path).toBe(true);
      expect(isPrSafePath(path), path).toBe(false);
      expect(selectGateTier("pr", true, [path]), path).toEqual({
        tier: "sharded",
        reason: "theme_contract_paths",
      });
    }

    expect(isThemeContractPath("apps/web/app/pages/about.vue")).toBe(false);
    expect(isPrSafePath("apps/web/app/pages/about.vue")).toBe(true);
  });

  test("fails a PR tier closed when its default base ref is unavailable", () => {
    expect(selectGateTier("pr", false, [])).toEqual({
      tier: "sharded",
      reason: "base_ref_unavailable",
    });
    expect(selectGateTier("pr", true, ["docs/x.md"])).toEqual({
      tier: "pr",
      reason: "all_paths_safe",
    });
  });

  test("keeps the CI check job on fast and local when hosted runs separately", () => {
    expect(selectGateTier("pr", false, ["package.json"], true)).toEqual({
      tier: "pr",
      reason: "hosted_lane_separate",
    });
  });

  test("propagates an explicit PR base to each commit-validation lane", async () => {
    const runner = await readFile("scripts/run-check-sharded.ts", "utf8");
    expect(runner).toContain(
      '...(baseRef ? { FRAME_OF_MIND_GATE_BASE_REF: baseRef } : {}),',
    );
  });

  test("wires the CI jobs to the complete lane set", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain(
      'bun run check:pr --base "origin/${{ github.base_ref || \'main\' }}"',
    );
    expect(workflow).toContain('FRAME_OF_MIND_GATE_HOSTED_LANE_SEPARATE: "1"');
    expect(workflow).toContain("hosted-contracts:\n    needs: check");
    expect(workflow).toContain("timeout-minutes: 40");
    expect(workflow).toContain("FRAME_OF_MIND_STEP_TIMEOUT_SECONDS: '1800'");
    expect(workflow).toContain("FRAME_OF_MIND_HOSTED_ACCESS_STEP_TIMEOUT_SECONDS: '300'");
    expect(workflow).toContain("FRAME_OF_MIND_GATE_PARALLELISM: '1'");
    expect(workflow).toContain("bunx playwright install --with-deps chromium");
    expect(workflow).toContain("bun run check:lane:hosted");

    for (const matrixEntry of [
      "os: ubuntu-latest\n            mode: fresh",
      "os: macos-latest\n            mode: fresh",
      "os: windows-latest\n            mode: install-only",
    ]) {
      expect(workflow).toContain(matrixEntry);
    }
  });

  test("keeps a secret-free Better Auth and D1 contract required", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["check:auth-contract"]).toBe(
      "FRAME_OF_MIND_HOSTED_CONTRACT_AUTH_MODE=better-auth "
        + "FRAME_OF_MIND_HOSTED_ACCESS_SCOPE=required "
        + "bun --no-env-file scripts/test-hosted-access-http.ts",
    );

    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const authJob = workflow.match(/\n  auth-contract:\n([\s\S]*?)\n  hosted-contracts:/)?.[1];
    expect(authJob).toBeDefined();
    expect(authJob).toContain("timeout-minutes: 15");
    expect(authJob).toContain("bunx playwright install --with-deps chromium");
    expect(authJob).toContain("bun run check:auth-contract");
    expect(authJob).toContain("if: failure()");
    expect(authJob).toContain("name: auth-contract-playwright-report");
    expect(authJob).toContain("test-results/playwright/artifacts/");
    expect(authJob).not.toContain("continue-on-error");
    expect(authJob).not.toContain("secrets.");
  });

  test("keys builds by the non-documentation git tree and scrubbed environment", async () => {
    expect(isBuildInputPath("node_modules")).toBe(false);
    expect(isBuildInputPath("apps/web/.nuxt/builds/meta.json")).toBe(false);
    expect(isBuildInputPath("apps/web/.output/server/index.mjs")).toBe(false);
    const fixture = await mkdtemp(join(tmpdir(), "frame-of-mind-build-key-test-"));
    const sourcePath = join(fixture, "src/domain/studio-schemas.ts");
    const readmePath = join(fixture, "README.md");
    try {
      await mkdir(join(fixture, "src/domain"), { recursive: true });
      await mkdir(join(fixture, "scripts"), { recursive: true });
      await writeFile(sourcePath, "export const schemaVersion = 1;\n");
      await writeFile(join(fixture, "scripts/build.ts"), "export {};\n");
      await writeFile(readmePath, "baseline\n");
      await runGit(fixture, ["init", "-q"]);
      await runGit(fixture, ["add", "."]);

      const caller = {
        PATH: process.env.PATH ?? "/usr/bin",
        HOME: process.env.HOME ?? fixture,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        CI: "1",
        NUXT_HOSTED_WORKFLOWS_ENABLED: "true",
        FRAME_OF_MIND_BUILD_CACHE: "/must-not-leak",
      };
      const additions = { NITRO_PRESET: "cloudflare_module" };
      const environment = scrubBuildEnvironment(additions, caller);
      expect(environment).toEqual({
        PATH: caller.PATH,
        HOME: caller.HOME,
        TMPDIR: caller.TMPDIR,
        CI: "1",
        NITRO_PRESET: "cloudflare_module",
      });
      const baseline = await buildContentHash(fixture, environment);

      await writeFile(sourcePath, "export const schemaVersion = 2;\n");
      expect(await buildContentHash(fixture, environment)).not.toBe(baseline);
      await writeFile(sourcePath, "export const schemaVersion = 1;\n");
      expect(await buildContentHash(fixture, environment)).toBe(baseline);

      await writeFile(readmePath, "documentation-only change\n");
      expect(await buildContentHash(fixture, environment)).toBe(baseline);
      expect(await buildContentHash(
        fixture,
        scrubBuildEnvironment(additions, { ...caller, NUXT_HOSTED_WORKFLOWS_ENABLED: "false" }),
      )).toBe(baseline);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
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

async function runGit(cwd: string, args: string[]): Promise<void> {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(stderr.trim());
}
