import { resolve } from "node:path";
import { buildContentHash } from "./check-build-cache";

// 2026-11-13: unchanged-base hosted failures moved this lane out of the PR gate.
// Review found writable success receipts could bypass both gates. Deploy is now
// only a continuation of successful checks in this process. Retire this wrapper
// when an enforced deployment pipeline proves hosted coverage for its exact source.
const mode = process.argv[2];
if (mode !== "check" && mode !== "deploy") throw new Error("Use check or deploy.");

try {
  const before = await sourceIdentity();
  for (const step of ["check:pr", "check:lane:hosted"]) {
    const code = await run([process.execPath, "--no-env-file", "run", step]);
    if (code !== 0) throw new Error(`step_failed:${step}:${code}`);
  }
  const after = await sourceIdentity();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("source_changed_during_check");
  console.log(`CHECK_DEPLOY status=PASS head=${after.head} hosted=PASS`);
  if (mode === "deploy") {
    console.log(`HOSTED_DEPLOY prerequisite=PASS head=${after.head}`);
    process.exitCode = await run([
      "node", resolve("apps/web/node_modules/wrangler/bin/wrangler.js"),
      "deploy", ...process.argv.slice(3),
    ]);
  }
} catch (error) {
  console.error(`HOSTED_DEPLOY status=FAIL reason=${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 1;
}

async function sourceIdentity(): Promise<{ head: string; inputs: string }> {
  // The hosted contracts regenerate screenshots. All other tracked edits refuse.
  const dirty = await git("diff", "--name-only", "HEAD", "--", ".", ":!apps/web/e2e/__screenshots__");
  if (dirty) throw new Error("tracked_tree_dirty");
  return {
    head: await git("rev-parse", "HEAD"),
    inputs: await buildContentHash(process.cwd(), {}),
  };
}

async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, , code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error("git_identity_failed");
  return stdout.trim();
}

async function run(command: string[]): Promise<number> {
  return await Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}
