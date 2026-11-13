import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

const trackedPaths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const pin = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
// Current installation/runtime requirements, not historical measurements in
// changelogs, ADRs, incident notes, or dated experiments. CLAUDE.md aliases point
// at the corresponding AGENTS.md source. Add new Bun setup instructions here.
const currentBunRequirementDocs = [
  ".agents/skills/frame-of-mind/SKILL.md",
  ".github/AGENTS.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "README.md",
  "apps/web/server-local/AGENTS.md",
  "conductor/tech-stack.md",
  "docs/CLOUDFLARE_DEPLOYMENT.md",
  "docs/RUNBOOK.md",
  "docs/SKILL_INSTALLATION.md",
];

// Incident 2026-11-13: CI's Bun pin drifted from the documented runtime.
// Retire when workflows and documentation consume packageManager directly.
test("Bun versions in workflows and current documentation agree with packageManager", async () => {
  expect(pin, "packageManager must pin an exact Bun release").toBeDefined();
  const violations: string[] = [];
  let setups = 0;
  for (const path of trackedPaths.filter((path) => /^\.github\/workflows\/.*\.ya?ml$/.test(path))) {
    const workflow = Bun.YAML.parse(await readFile(path, "utf8")) as Workflow;
    for (const [job, config] of Object.entries(workflow.jobs ?? {})) {
      for (const step of config.steps ?? []) {
        if (!step.uses?.startsWith("oven-sh/setup-bun@")) continue;
        setups++;
        const actual = step.with?.["bun-version"];
        if (actual !== pin) violations.push(`${path} job=${job}: Bun ${actual} != packageManager Bun ${pin}`);
      }
    }
  }
  expect(setups, "at least one live setup-bun step is required").toBeGreaterThan(0);

  for (const path of currentBunRequirementDocs) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/\b[Bb]un(?:[\s|]+|[-@])v?(\d+\.\d+(?:\.\d+)?)/g)) {
      if (match[1] !== pin) violations.push(`${path}: Bun ${match[1]} != packageManager Bun ${pin}`);
    }
  }
  expect(violations, violations.join("\n")).toEqual([]);
});

test("CI check retains the high-severity production audit", async () => {
  const workflow = Bun.YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
  const commands = (workflow.jobs?.check?.steps ?? []).flatMap((step) =>
    (step.run ?? "").split(/\r?\n/).map((line) => line.trim()),
  );
  expect(commands, "CI check must run bun audit --production --audit-level=high")
    .toContain("bun audit --production --audit-level=high");
});
