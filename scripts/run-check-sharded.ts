import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUILD_DIR_ENV } from "./prebuilt-artifact";
import { selectGateTier, type GateTier } from "./check-gate-policy";

const allLaneNames = ["fast", "local", "hosted"] as const;
type LaneName = typeof allLaneNames[number];
interface LaneResult {
  readonly lane: LaneName;
  readonly exitCode: number;
  readonly seconds: number;
}

const args = process.argv.slice(2);
const requestedTier = option("--tier") ?? "sharded";
if (requestedTier !== "pr" && requestedTier !== "sharded") {
  throw new Error("--tier must be pr or sharded.");
}
const configuredBaseRef = option("--base")
  ?? process.env.FRAME_OF_MIND_GATE_BASE_REF?.trim();
const baseRef = requestedTier === "pr" ? configuredBaseRef || "origin/main" : configuredBaseRef;
const printTier = args.includes("--print-tier");
const baseRefAvailable = requestedTier !== "pr" || await isRefAvailable(baseRef!);
const changedPaths = requestedTier === "pr" && baseRefAvailable
  ? await pathsChangedSince(baseRef!)
  : [];
const hostedLaneSeparate = process.env.FRAME_OF_MIND_GATE_HOSTED_LANE_SEPARATE === "1";
const selection = selectGateTier(
  requestedTier as GateTier,
  baseRefAvailable,
  changedPaths,
  hostedLaneSeparate,
);
const selectedTier = selection.tier;

if (printTier) {
  console.log(selectedTier);
  process.exit(0);
}

const configuredParallelism = process.env.FRAME_OF_MIND_GATE_PARALLELISM ?? "3";
const parallelism = Number(configuredParallelism);
if (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 3) {
  throw new Error("FRAME_OF_MIND_GATE_PARALLELISM must be an integer from 1 to 3.");
}

const laneNames: readonly LaneName[] = selectedTier === "pr"
  ? ["fast", "local"]
  : allLaneNames;
const startedAt = performance.now();
const root = await mkdtemp(join(tmpdir(), "frame-of-mind-check-sharded-"));
const active = new Set<Bun.Subprocess>();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of active) child.kill(signal);
  });
}

try {
  console.log(
    `CHECK_SHARDED tier=${selectedTier} requested=${requestedTier} `
    + `upgraded=${requestedTier !== selectedTier} base=${baseRef ?? "none"} `
    + `reason=${selection.reason}`,
  );
  const queue = [...laneNames];
  const results: LaneResult[] = [];
  const workers = Array.from(
    { length: Math.min(parallelism, queue.length) },
    async () => {
      for (;;) {
        const lane = queue.shift();
        if (!lane) return;
        results.push(await runLane(lane));
      }
    },
  );
  await Promise.all(workers);
  results.sort(
    (left, right) => allLaneNames.indexOf(left.lane) - allLaneNames.indexOf(right.lane),
  );

  console.log("CHECK_SHARDED_SUMMARY lane     exit runtime_seconds");
  for (const result of results) {
    console.log(
      `CHECK_SHARDED_SUMMARY ${result.lane.padEnd(8)} ${String(result.exitCode).padStart(4)} `
      + `${result.seconds.toFixed(2).padStart(15)}`,
    );
  }
  const exitCode = results.reduce(
    (current, result) => current === 0 && result.exitCode !== 0
      ? result.exitCode
      : current,
    0,
  );
  console.log(
    `CHECK_SHARDED status=${exitCode === 0 ? "PASS" : "FAIL"} tier=${selectedTier} `
    + `parallelism=${parallelism} runtime_seconds=${secondsSince(startedAt)}`,
  );
  process.exitCode = exitCode;
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runLane(lane: LaneName): Promise<LaneResult> {
  const laneStartedAt = performance.now();
  console.log(`[${lane}] CHECK_SHARDED lane=${lane} status=START`);
  const child = Bun.spawn(["bun", "run", `check:lane:${lane}`], {
    cwd: resolve("."),
    env: {
      ...process.env,
      [BUILD_DIR_ENV]: join(root, `${lane}-nuxt-build`),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  active.add(child);
  await Promise.all([
    pipePrefixed(child.stdout, lane, false),
    pipePrefixed(child.stderr, lane, true),
  ]);
  const exitCode = await child.exited;
  active.delete(child);
  const seconds = (performance.now() - laneStartedAt) / 1_000;
  console.log(
    `[${lane}] CHECK_SHARDED lane=${lane} status=${exitCode === 0 ? "PASS" : "FAIL"} `
    + `exit=${exitCode} runtime_seconds=${seconds.toFixed(2)}`,
  );
  return { lane, exitCode, seconds };
}

async function isRefAvailable(ref: string): Promise<boolean> {
  const child = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: resolve("."),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return await child.exited === 0;
}

async function pathsChangedSince(ref: string): Promise<string[]> {
  const child = Bun.spawn(["git", "diff", "--name-only", `${ref}...HEAD`], {
    cwd: resolve("."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not compare gate base ${ref}: ${stderr.trim()}`);
  }
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function pipePrefixed(
  stream: ReadableStream<Uint8Array>,
  lane: LaneName,
  error: boolean,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) writeLine(`[${lane}] ${line}\n`, error);
    if (done) break;
  }
  if (pending) writeLine(`[${lane}] ${pending}\n`, error);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function writeLine(line: string, error: boolean): void {
  (error ? process.stderr : process.stdout).write(line);
}

function secondsSince(start: number): string {
  return ((performance.now() - start) / 1_000).toFixed(2);
}
