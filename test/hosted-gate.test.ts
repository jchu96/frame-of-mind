import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildContentHash } from "../scripts/check-build-cache";

const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts as Record<string, string>;
const hostedSteps = [
  "test:hosted-access-http", "test:hosted-access-http:better-auth",
  "test:hosted-workflows-http", "test:hosted-workflows-http:better-auth",
  "test:hosted-media-http", "check:hosted-auth", "check:e2e", "rehearse:hosted-release",
];

describe("hosted gate separation", () => {
  test("MISS deploy-needs-hosted: hand-written fresh or stale receipts cannot bypass failing hosted checks", async () => {
    for (const age of [0, 25 * 60 * 60 * 1000]) {
      const root = await fixture();
      try {
        // Reproduce the reviewer's forgery without ever invoking check:deploy.
        const head = (await run(root, ["git", "rev-parse", "HEAD"])).stdout.trim();
        await put(root, ".git/hosted-deploy-receipt.json", JSON.stringify({
          version: 1, head, inputs: await buildContentHash(root, {}),
          hosted: "PASS", completedAt: Date.now() - age,
        }));
        const result = await run(root, ["bun", "run", "deploy:hosted"], { FAIL_HOSTED: "1" });
        await refused(root, result);
        expect(result.stdout).toContain("FIXTURE_LANE hosted");
        expect(result.stderr).toContain("step_failed:check:lane:hosted:1");
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }, 30_000);

  test("MISS default-gate-clean: executes only fast/local for website changes and missing refs", async () => {
    const root = await fixture();
    try {
      for (const path of ["apps/web/app/pages/index.vue", "apps/web/app/assets/css/main.css", "src/cli.ts"]) {
        await put(root, path, "// changed fixture\n");
        await commit(root);
        const tier = await run(root, ["bun", "run", "check:pr", "--base", "HEAD~1", "--print-tier"]);
        expect(tier.code).toBe(0);
        expect(tier.stdout.trim()).toBe("pr");
        const result = await run(root, ["bun", "run", "check:pr", "--base", "HEAD~1"]);
        assertDefault(result);
      }
      assertDefault(await run(root, ["bun", "run", "check:pr", "--base", "missing-ref"]));
      const full = await run(root, ["bun", "run", "check:sharded"]);
      expect(full.code).toBe(0);
      expect(full.stdout).toContain("FIXTURE_LANE hosted");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("keeps every hosted logical step in the standalone lane", () => {
    expect(scripts["check:lane:hosted"]).toBe(
      `bun scripts/run-check-lane.ts hosted ${hostedSteps.join(" ")}`,
    );
  });

  test("MISS hosted-runs-nightly: schedule and manual events run the whole lane even after default failure", async () => {
    const parsed = await run(process.cwd(), ["bun", "--no-env-file", "-e",
      'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text())))']);
    expect(parsed.code, parsed.stderr).toBe(0);
    const workflow = JSON.parse(parsed.stdout);
    expect(workflow.on.schedule.length).toBeGreaterThan(0);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    const job = workflow.jobs["serial-check"];
    expect(job.if).toBe("${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}");
    expect(job["continue-on-error"] ?? false).toBe(false);
    const defaults = job.steps.filter((step: { run?: string }) => step.run === "bun run check:pr");
    const hosted = job.steps.filter((step: { run?: string }) => step.run === "bun run check:lane:hosted");
    expect(defaults).toHaveLength(1);
    expect(hosted).toHaveLength(1);
    expect(hosted[0].if).toBe("${{ !cancelled() }}");
    expect(hosted[0]["continue-on-error"] ?? false).toBe(false);
    expect(workflow.jobs).not.toHaveProperty("hosted-contracts");
  });

  test("quarantine records an issue and a measurable return rule for the whole lane", async () => {
    const quarantine = await readFile("docs/HOSTED_GATE_QUARANTINE.md", "utf8");
    expect(quarantine).toContain("check:lane:hosted");
    expect(quarantine).toMatch(/\[.*?\]\(https:\/\/github.com\/jchu96\/frame-of-mind\/issues\/(?:\d+|PENDING)\)/);
    expect(quarantine).toContain("ten consecutive");
    expect(quarantine).toContain("three consecutive nightly");
    expect(quarantine).toContain("without retries");
  });

  test("MISS deploy-needs-hosted: every deployment runs both gates before Wrangler; check mode never deploys", async () => {
    const root = await fixture();
    try {
      const preflight = await run(root, ["bun", "run", "check:deploy"]);
      expect(preflight.code, preflight.stderr).toBe(0);
      expect(preflight.stdout).toContain("CHECK_DEPLOY status=PASS");
      await expect(readFile(join(root, ".git/deployed.json"))).rejects.toThrow();
      // A previous check invocation is never reusable authorization.
      for (let attempt = 0; attempt < 2; attempt++) {
        await rm(join(root, ".git/execution.log"));
        const result = await run(root, ["bun", "run", "deploy:hosted", "--config", "fixture.json"]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain("HOSTED_DEPLOY prerequisite=PASS");
        const order = (await readFile(join(root, ".git/execution.log"), "utf8")).trim().split("\n");
        expect(order.slice(0, 2).sort()).toEqual(["fast", "local"]);
        expect(order.slice(2)).toEqual(["hosted", "wrangler"]);
        expect(JSON.parse(await readFile(join(root, ".git/deployed.json"), "utf8")))
          .toEqual(["deploy", "--config", "fixture.json"]);
      }
      console.log("DEPLOY_FIXTURE green=PASS same_invocation=true wrangler=synthetic");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("MISS deploy-needs-hosted: default or hosted failure propagates in check and deploy modes", async () => {
    const root = await fixture();
    try {
      expect((await run(root, ["bun", "run", "check:deploy"])).code).toBe(0);
      for (const mode of ["check:deploy", "deploy:hosted"]) {
        for (const failure of ["FAIL_DEFAULT", "FAIL_HOSTED"]) {
          const result = await run(root, ["bun", "run", mode], { [failure]: "1" });
          await refused(root, result);
          const step = failure === "FAIL_HOSTED" ? "check:lane:hosted" : "check:pr";
          expect(result.stderr).toContain(`step_failed:${step}:1`);
        }
      }
      console.log("DEPLOY_FIXTURE red=PASS gate_exit=1 deploy_refused=true");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("MISS deploy-source-stable: dirty source, or HEAD/input changes during checks refuse Wrangler", async () => {
    for (const change of ["dirty", "head", "input"]) {
      const root = await fixture();
      try {
        if (change === "dirty") await put(root, "source.ts", "// dirty\n");
        const result = await run(root, ["bun", "run", "deploy:hosted"], { CHANGE_SOURCE: change });
        await refused(root, result);
        expect(result.stderr).toContain(change === "dirty" ? "tracked_tree_dirty" : "source_changed_during_check");
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }, 30_000);
});

function assertDefault(result: Result): void {
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("FIXTURE_LANE fast");
  expect(result.stdout).toContain("FIXTURE_LANE local");
  expect(result.stdout).not.toContain("FIXTURE_LANE hosted");
  expect(result.stdout).toContain("CHECK_PR hosted=excluded runs=nightly,manual,check:deploy");
}

async function refused(root: string, result: Result): Promise<void> {
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("HOSTED_DEPLOY status=FAIL");
  await expect(readFile(join(root, ".git/deployed.json"))).rejects.toThrow();
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hosted-gate-fixture-"));
  for (const file of ["scripts/run-check-sharded.ts", "scripts/check-gate-policy.ts",
    "scripts/prebuilt-artifact.ts", "scripts/hosted-deploy-gate.ts", "scripts/check-build-cache.ts"]) {
    await put(root, file, await readFile(file, "utf8"));
  }
  await put(root, "package.json", JSON.stringify({ type: "module", scripts: {
    "check:pr": scripts["check:pr"], "check:sharded": scripts["check:sharded"],
    "check:deploy": scripts["check:deploy"], "deploy:hosted": scripts["deploy:hosted"],
    ...Object.fromEntries(["fast", "local", "hosted"].map((lane) =>
      [`check:lane:${lane}`, `bun fixture-lane.ts ${lane}`])),
  } }));
  await put(root, "fixture-lane.ts", `
import { appendFileSync, writeFileSync } from "node:fs";
const lane = process.argv[2];
appendFileSync(".git/execution.log", lane + "\\n");
console.log("FIXTURE_LANE " + lane);
if (lane === "fast") console.log("FIXTURE_LANE pr");
if (lane === "hosted" && process.env.CHANGE_SOURCE === "input") writeFileSync("untracked.ts", "// new code");
if (lane === "hosted" && process.env.CHANGE_SOURCE === "head") {
  const change = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "new head"]);
  if (change.exitCode !== 0) throw new Error("fixture commit failed");
}
process.exitCode = (lane === "hosted" && process.env.FAIL_HOSTED === "1")
  || (lane === "fast" && process.env.FAIL_DEFAULT === "1") ? 1 : 0;
`);
  await put(root, "apps/web/node_modules/wrangler/bin/wrangler.js", `
import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(".git/execution.log", "wrangler\\n");
writeFileSync(".git/deployed.json", JSON.stringify(process.argv.slice(2)));
console.log("SYNTHETIC_WRANGLER");
`);
  await put(root, "source.ts", "// fixture\n");
  await git(root, ["init", "-q"]);
  await commit(root);
  return root;
}

async function put(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function commit(root: string): Promise<void> {
  await git(root, ["add", "."]);
  await git(root, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
}
async function git(root: string, args: string[]): Promise<void> {
  const result = await run(root, ["git", ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
}
interface Result { code: number; stdout: string; stderr: string }
async function run(root: string, command: string[], extra: Record<string, string> = {}): Promise<Result> {
  const child = spawn(command[0]!, command.slice(1), {
    cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TZ: "UTC", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return { code, stdout, stderr };
}
