import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts as Record<string, string>;
const hostedSteps = [
  "test:hosted-access-http", "test:hosted-access-http:better-auth",
  "test:hosted-workflows-http", "test:hosted-workflows-http:better-auth",
  "test:hosted-media-http", "check:hosted-auth", "check:e2e", "rehearse:hosted-release",
];

describe("hosted gate separation", () => {
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
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toMatch(/^  schedule:\n    - cron: /m);
    expect(workflow).toMatch(/^  workflow_dispatch:/m);
    const job = workflow.match(/^  serial-check:\n([\s\S]*?)(?=^  [a-z][a-z-]*:|$(?![\s\S]))/m)?.[1];
    expect(job).toBeDefined();
    expect(job).toContain("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(job).toContain("run: bun run check:pr");
    expect(job).toContain("if: ${{ !cancelled() }}\n        run: bun run check:lane:hosted");
    expect(workflow).not.toContain("  hosted-contracts:");
  });

  test("quarantine records an issue and a measurable return rule for the whole lane", async () => {
    const quarantine = await readFile("docs/HOSTED_GATE_QUARANTINE.md", "utf8");
    expect(quarantine).toContain("check:lane:hosted");
    expect(quarantine).toMatch(/\[.*?\]\(https:\/\/github.com\/jchu96\/frame-of-mind\/issues\/(?:\d+|PENDING)\)/);
    expect(quarantine).toContain("ten consecutive");
    expect(quarantine).toContain("three consecutive nightly");
    expect(quarantine).toContain("without retries");
  });

  test("MISS deploy-needs-hosted: missing, invalid, stale, wrong-head and changed-source receipts refuse Wrangler", async () => {
    const root = await fixture();
    try {
      const deploy = () => run(root, ["bun", "run", "deploy:hosted", "--config", "fixture.json"]);
      await refused(root, await deploy());
      const preflight = await run(root, ["bun", "run", "check:deploy"]);
      expect(preflight.code, preflight.stderr).toBe(0);
      expect(preflight.stdout).toContain("FIXTURE_LANE pr");
      expect(preflight.stdout).toContain("FIXTURE_LANE hosted");
      expect(preflight.stdout).toContain("CHECK_DEPLOY status=PASS");
      const receiptPath = join(root, ".git/hosted-deploy-receipt.json");
      const good = JSON.parse(await readFile(receiptPath, "utf8"));
      for (const invalid of [
        "not json", "null", JSON.stringify({ ...good, hosted: "FAIL" }),
        JSON.stringify({ ...good, completedAt: Date.now() - 25 * 60 * 60 * 1000 }),
        JSON.stringify({ ...good, completedAt: Date.now() + 60_000 }),
        JSON.stringify({ ...good, head: "0".repeat(40) }),
        JSON.stringify({ ...good, inputs: "different-source" }),
      ]) {
        await writeFile(receiptPath, invalid);
        await refused(root, await deploy());
      }
      await writeFile(receiptPath, JSON.stringify(good));
      await put(root, "source.ts", "// dirty\n");
      await refused(root, await deploy());
      await put(root, "source.ts", "// fixture\n");
      await put(root, "untracked.ts", "// new code\n");
      await refused(root, await deploy());
      await rm(join(root, "untracked.ts"));
      const allowed = await deploy();
      expect(allowed.code, allowed.stderr).toBe(0);
      expect(allowed.stdout).toContain("HOSTED_DEPLOY prerequisite=PASS");
      expect(JSON.parse(await readFile(join(root, ".git/deployed.json"), "utf8")))
        .toEqual(["deploy", "--config", "fixture.json"]);
      console.log("DEPLOY_FIXTURE green=PASS valid_hosted_receipt=true wrangler=synthetic");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("hosted preflight failure propagates and invalidates the previous success", async () => {
    const root = await fixture();
    try {
      expect((await run(root, ["bun", "run", "check:deploy"])).code).toBe(0);
      const failed = await run(root, ["bun", "run", "check:deploy"], { FAIL_HOSTED: "1" });
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("step_failed:check:lane:hosted:1");
      await refused(root, await run(root, ["bun", "run", "deploy:hosted"]));
      console.log("DEPLOY_FIXTURE red=PASS hosted_exit=1 deploy_refused=true");
    } finally { await rm(root, { recursive: true, force: true }); }
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
const lane = process.argv[2];
console.log("FIXTURE_LANE " + lane);
if (lane === "fast") console.log("FIXTURE_LANE pr");
process.exitCode = lane === "hosted" && process.env.FAIL_HOSTED === "1" ? 1 : 0;
`);
  await put(root, "apps/web/node_modules/wrangler/bin/wrangler.js", `
import { writeFileSync } from "node:fs";
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
