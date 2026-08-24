import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  acquireE2EResourceLease,
  E2E_RUNTIME_LEASE_TOKEN_ENV,
  type E2EResourceLease,
} from "../apps/web/e2e/support/isolation";
import {
  BUILD_DIR_ENV,
  BUILD_OUTPUT_ENV,
  PREBUILT_OUTPUT_ENV,
  PREBUILT_WORKFLOWS_ENV,
  writeBuildMarker,
} from "./prebuilt-artifact";
import { killOwnedProcessGroup, runTimedProcess } from "./check-process";
import { buildContentHash, scrubBuildEnvironment } from "./check-build-cache";
import { resolveHostedAccessStepTimeoutSeconds } from "./hosted-access-timeout";

type Lane = "fast" | "local" | "hosted";

const expectedSteps: Record<Lane, readonly string[]> = {
  fast: ["check:repo-hygiene", "typecheck", "test", "test:web"],
  local: [
    "build:cli",
    "build:web",
    "test:studio-http",
    "spike:studio-streaming",
  ],
  hosted: [
    "test:hosted-access-http",
    "test:hosted-access-http:better-auth",
    "test:hosted-workflows-http",
    "test:hosted-workflows-http:better-auth",
    "test:hosted-media-http",
    "check:hosted-auth",
    "check:e2e",
    "rehearse:hosted-release",
  ],
};

const lane = process.argv[2] as Lane | undefined;
const steps = process.argv.slice(3);
if (!lane || !(lane in expectedSteps)) {
  throw new Error("Usage: run-check-lane.ts <fast|local|hosted> <logical steps...>");
}
if (JSON.stringify(steps) !== JSON.stringify(expectedSteps[lane])) {
  throw new Error(
    `check_lane_steps_mismatch lane=${lane} expected=${expectedSteps[lane].join(",")} `
    + `actual=${steps.join(",")}`,
  );
}

const timeoutSeconds = Number(process.env.FRAME_OF_MIND_STEP_TIMEOUT_SECONDS ?? "1200");
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
  throw new Error("FRAME_OF_MIND_STEP_TIMEOUT_SECONDS must be a positive integer.");
}
const hostedAccessTimeoutSeconds = Number(
  process.env.FRAME_OF_MIND_HOSTED_ACCESS_STEP_TIMEOUT_SECONDS ?? timeoutSeconds,
);
if (!Number.isSafeInteger(hostedAccessTimeoutSeconds) || hostedAccessTimeoutSeconds < 1) {
  throw new Error(
    "FRAME_OF_MIND_HOSTED_ACCESS_STEP_TIMEOUT_SECONDS must be a positive integer.",
  );
}

const startedAt = performance.now();
const root = await mkdtemp(join(tmpdir(), `frame-of-mind-check-${lane}-`));
const buildDir = join(root, "nuxt-build");
let webOutput = join(root, "web-output");
let workflowOutput = join(root, "workflow-output");
let activeChild: ChildProcess | undefined;
let runtimeLease: E2EResourceLease | undefined;
let laneExitCode = 0;

class LaneFailure extends Error {
  constructor(readonly exitCode: number) {
    super(`Gate lane failed with exit code ${exitCode}.`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (activeChild) killOwnedProcessGroup(activeChild, signal, true);
  });
}

try {
  if (lane !== "fast") {
    ({ webOutput, workflowOutput } = await prepareBuildArtifacts(lane));
  }

  if (lane !== "fast") {
    runtimeLease = await acquireE2EResourceLease();
  }

  const laneEnvironment: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...(lane === "fast" ? {} : { [BUILD_DIR_ENV]: buildDir }),
    ...(lane === "fast" ? {} : { [PREBUILT_OUTPUT_ENV]: webOutput }),
    ...(lane === "fast" ? {} : { [E2E_RUNTIME_LEASE_TOKEN_ENV]: runtimeLease!.token }),
    ...(lane === "hosted"
      ? {
          [PREBUILT_WORKFLOWS_ENV]: workflowOutput,
        }
      : {}),
  };
  if (lane === "fast") delete laneEnvironment[BUILD_DIR_ENV];

  for (const step of steps) {
    if (step === "build:web") {
      console.log(
        `CHECK_LANE lane=${lane} step=${step} status=PASS prebuilt=true runtime_seconds=0.00`,
      );
      continue;
    }
    const stepTimeoutSeconds = resolveHostedAccessStepTimeoutSeconds(
      step,
      timeoutSeconds,
      hostedAccessTimeoutSeconds,
    );
    const first = await runStep(step, laneEnvironment, 0, stepTimeoutSeconds);
    const retryTimedOutWorkflow = first.timedOut && (
      step === "test:hosted-workflows-http:better-auth"
      || (process.env.CI === "true" && step === "test:hosted-workflows-http")
    );
    if (
      retryTimedOutWorkflow
    ) {
      console.log(
        `CHECK_LANE lane=${lane} step=${step} retry=1 `
        + "reason=step_timeout",
      );
      const retry = await runStep(step, laneEnvironment, 1, stepTimeoutSeconds);
      if (retry.exitCode !== 0) throw new LaneFailure(retry.exitCode);
    } else if (first.exitCode !== 0) {
      throw new LaneFailure(first.exitCode);
    }
  }

  console.log(
    `CHECK_LANE lane=${lane} status=PASS runtime_seconds=${secondsSince(startedAt)}`,
  );
} catch (error) {
  if (error instanceof LaneFailure) {
    laneExitCode = error.exitCode;
  } else {
    throw error;
  }
} finally {
  activeChild = undefined;
  await runtimeLease?.release();
  await rm(root, { recursive: true, force: true });
}
process.exitCode = laneExitCode;

async function prepareBuildArtifacts(selectedLane: "local" | "hosted"): Promise<{
  webOutput: string;
  workflowOutput: string;
}> {
  const cacheSetting = process.env.FRAME_OF_MIND_BUILD_CACHE?.trim();
  const cacheEnabled = cacheSetting !== "off";
  const contentHash = cacheEnabled
    ? await buildContentHash(resolve("."), buildCacheEnvironment(selectedLane))
    : "cache-disabled";
  const hash8 = contentHash.slice(0, 8);
  const cacheRoot = cacheSetting && cacheSetting !== "off"
    ? resolve(cacheSetting)
    : join(homedir(), ".cache", "frame-of-mind", "builds");
  const cacheEntry = join(cacheRoot, `${selectedLane}-${contentHash}`);
  const localWebOutput = join(root, "web-output");
  const localWorkflowOutput = join(root, "workflow-output");

  if (!cacheEnabled) {
    await buildArtifacts(selectedLane, localWebOutput, localWorkflowOutput, buildDir);
    return { webOutput: localWebOutput, workflowOutput: localWorkflowOutput };
  }

  await mkdir(cacheRoot, { recursive: true });
  const lease = await acquireE2EResourceLease(`${cacheEntry}.lock`);
  try {
    if (!(await isCompleteCacheEntry(cacheEntry, selectedLane))) {
      await rm(cacheEntry, { recursive: true, force: true });
      const staging = await mkdtemp(join(cacheRoot, `.build-${selectedLane}-`));
      try {
        const stagedWeb = join(staging, "web-output");
        const stagedWorkflows = join(staging, "workflow-output");
        const stagedBuild = join(staging, "nuxt-build");
        await buildArtifacts(selectedLane, stagedWeb, stagedWorkflows, stagedBuild);
        await Promise.all([
          rm(stagedBuild, { recursive: true, force: true }),
          rm(join(staging, ".wrangler"), { recursive: true, force: true }),
          rm(join(staging, "workflow-build.wrangler.json"), { force: true }),
        ]);
        await rename(staging, cacheEntry);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    } else {
      const now = new Date();
      await utimes(cacheEntry, now, now);
      console.log(`CHECK_LANE lane=${lane} build=CACHED ${hash8}`);
    }
    await cp(join(cacheEntry, "web-output"), localWebOutput, { recursive: true });
    if (selectedLane === "hosted") {
      await cp(join(cacheEntry, "workflow-output"), localWorkflowOutput, {
        recursive: true,
      });
    }
  } finally {
    await lease.release();
  }
  await pruneCache(cacheRoot, cacheEntry);
  return { webOutput: localWebOutput, workflowOutput: localWorkflowOutput };
}

async function buildArtifacts(
  selectedLane: "local" | "hosted",
  selectedWebOutput: string,
  selectedWorkflowOutput: string,
  selectedBuildDir: string,
): Promise<void> {
  if (selectedLane === "local") {
    await runBuild(
      ["bun", "--no-env-file", "run", "--cwd", "apps/web", "build"],
      {
        FRAME_OF_MIND_DB_DRIVER: "sqlite",
        FRAME_OF_MIND_STUDIO: "1",
        FRAME_OF_MIND_STUDIO_SPIKE: "1",
        NITRO_PRESET: "node-server",
        [BUILD_DIR_ENV]: selectedBuildDir,
        [BUILD_OUTPUT_ENV]: selectedWebOutput,
      },
      "node-server",
    );
    await writeBuildMarker(selectedWebOutput, "node-server");
    return;
  }

  await runBuild(
    ["bun", "--no-env-file", "run", "--cwd", "apps/web", "build:cloudflare"],
    {
      FRAME_OF_MIND_DB_DRIVER: "d1",
      FRAME_OF_MIND_STUDIO: "1",
      FRAME_OF_MIND_HOSTED_WORKFLOWS: "1",
      NITRO_PRESET: "cloudflare_module",
      [BUILD_DIR_ENV]: selectedBuildDir,
      [BUILD_OUTPUT_ENV]: selectedWebOutput,
    },
    "cloudflare_module",
  );
  await writeBuildMarker(selectedWebOutput, "cloudflare_module");
  await buildWorkflows(selectedWorkflowOutput, resolve(selectedWorkflowOutput, ".."));
  await writeBuildMarker(selectedWorkflowOutput, "cloudflare-workflows");
}

async function runStep(
  step: string,
  environment: Record<string, string>,
  retry = 0,
  stepTimeoutSeconds = timeoutSeconds,
): Promise<{ exitCode: number; timedOut: boolean }> {
  const stepStartedAt = performance.now();
  const result = await runTimedProcess(["bun", "run", step], {
    cwd: resolve("."),
    env: environment,
    timeoutSeconds: stepTimeoutSeconds,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    onStart: (child) => { activeChild = child; },
    onFinish: () => { activeChild = undefined; },
  });
  console.log(
    `CHECK_LANE lane=${lane} step=${step} status=${result.exitCode === 0 ? "PASS" : "FAIL"} `
    + `exit=${result.timedOut ? "step_timeout" : result.exitCode} retry=${retry} `
    + `runtime_seconds=${secondsSince(stepStartedAt)}`,
  );
  return result;
}

async function runBuild(
  command: string[],
  additions: Record<string, string>,
  preset: string,
): Promise<void> {
  const buildStartedAt = performance.now();
  console.log(`CHECK_LANE lane=${lane} build=START preset=${preset}`);
  const result = await runTimedProcess(command, {
    cwd: resolve("."),
    env: scrubBuildEnvironment(additions),
    timeoutSeconds,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    onStart: (child) => { activeChild = child; },
    onFinish: () => { activeChild = undefined; },
  });
  if (result.exitCode !== 0) {
    console.error(
      `CHECK_LANE lane=${lane} build=FAIL preset=${preset} `
      + `exit=${result.timedOut ? "step_timeout" : result.exitCode}`,
    );
    throw new LaneFailure(result.exitCode);
  }
  console.log(
    `CHECK_LANE lane=${lane} build=PASS preset=${preset} `
    + `runtime_seconds=${secondsSince(buildStartedAt)}`,
  );
}

async function buildWorkflows(output: string, temporaryRoot: string): Promise<void> {
  const configPath = join(temporaryRoot, "workflow-build.wrangler.json");
  await writeFile(configPath, JSON.stringify({
    $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
    name: `frame-of-mind-check-workflows-${randomUUID().slice(0, 12)}`,
    main: resolve("apps/workflows/src/index.ts"),
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{
      binding: "DB",
      database_name: "frame-of-mind-check-workflows",
      database_id: randomUUID(),
      migrations_dir: resolve("apps/web/db/migrations"),
    }],
    workflows: [{
      name: `frame-of-mind-check-analysis-${randomUUID().slice(0, 12)}`,
      binding: "HOSTED_WORKFLOW",
      class_name: "HostedAnalysisWorkflow",
    }],
  }, null, 2));
  await runBuild([
    "node",
    resolve("apps/web/node_modules/wrangler/bin/wrangler.js"),
    "deploy",
    "--dry-run",
    "--config",
    configPath,
    "--outdir",
    output,
  ], {}, "cloudflare-workflows");
}

function buildCacheEnvironment(selectedLane: "local" | "hosted"): Record<string, string> {
  return scrubBuildEnvironment(selectedLane === "local"
    ? {
        FRAME_OF_MIND_DB_DRIVER: "sqlite",
        FRAME_OF_MIND_STUDIO: "1",
        FRAME_OF_MIND_STUDIO_SPIKE: "1",
        NITRO_PRESET: "node-server",
      }
    : {
        FRAME_OF_MIND_DB_DRIVER: "d1",
        FRAME_OF_MIND_STUDIO: "1",
        FRAME_OF_MIND_HOSTED_WORKFLOWS: "1",
        NITRO_PRESET: "cloudflare_module",
      });
}

async function isCompleteCacheEntry(
  entry: string,
  selectedLane: "local" | "hosted",
): Promise<boolean> {
  const required = [
    join(entry, "web-output", ".frame-of-mind-build.json"),
    join(entry, "web-output", "server", "index.mjs"),
    ...(selectedLane === "hosted"
      ? [
          join(entry, "web-output", "server", "hosted-entry.mjs"),
          join(entry, "workflow-output", ".frame-of-mind-build.json"),
          join(entry, "workflow-output", "index.js"),
        ]
      : []),
  ];
  return (await Promise.all(required.map(async (path) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }))).every(Boolean);
}

async function pruneCache(cacheRoot: string, currentEntry: string): Promise<void> {
  const entries = await Promise.all((await readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()
      && !entry.name.startsWith(".")
      && !entry.name.endsWith(".lock"))
    .map(async (entry) => ({
      path: join(cacheRoot, entry.name),
      mtimeMs: (await stat(join(cacheRoot, entry.name))).mtimeMs,
    })));
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const entry of entries.slice(5)) {
    if (entry.path !== currentEntry) {
      await rm(entry.path, { recursive: true, force: true });
    }
  }
}

function secondsSince(start: number): string {
  return ((performance.now() - start) / 1_000).toFixed(2);
}
