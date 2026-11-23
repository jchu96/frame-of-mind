import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { buildContentHash } from "./check-build-cache";

// 2026-11-13: unchanged-base hosted failures moved this lane out of the PR gate.
// Review found writable success receipts could bypass both gates. Deploy is now
// only a continuation of successful checks in this process. Retire this wrapper
// when an enforced deployment pipeline proves hosted coverage for its exact source.
const mode = process.argv[2];
if (mode !== "check" && mode !== "deploy") throw new Error("Use check or deploy.");

try {
  await requireDefaultEnvironment();
  const deployArgs = mode === "deploy" ? await checkedDeployArgs(process.argv.slice(3)) : [];
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
      "deploy", ...deployArgs,
    ]);
  }
} catch (error) {
  console.error(`HOSTED_DEPLOY status=FAIL reason=${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 1;
}

async function checkedDeployArgs(args: string[]): Promise<string[]> {
  const root = await realpath(await git("rev-parse", "--show-toplevel"));
  if (await realpath(process.cwd()) !== root) throw new Error("deploy_argument_refused:cwd_must_be_repo_root");
  const [target] = args;
  if (args.length !== 1 || (target !== "web" && target !== "workflows")) {
    throw new Error("deploy_target_invalid valid_targets=web,workflows");
  }
  async function inside(path: string, argument: string): Promise<string> {
    const absolute = resolve(path);
    let target: string;
    try { target = await realpath(absolute); }
    catch { throw new Error(`deploy_argument_unresolvable:${argument}`); }
    const fromRoot = relative(root, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`deploy_argument_outside_repo:${argument}`);
    }
    return absolute;
  }
  const configPath = await inside(
    target === "web" ? "apps/web/wrangler.jsonc" : "apps/workflows/wrangler.jsonc", "--config",
  );
  const { experimental_readRawConfig } = createRequire(resolve("apps/web/package.json"))("wrangler");
  let config;
  try { config = experimental_readRawConfig({ config: configPath }).rawConfig; }
  catch { throw new Error("deploy_argument_invalid:--config"); }
  for (const [field, path] of [
    ["main", config.main], ["assets.directory", config.assets?.directory], ["site.bucket", config.site?.bucket],
  ]) {
    if (path !== undefined) await inside(resolve(dirname(configPath), path), `--config:${field}`);
  }
  return ["--config", configPath];
}

async function requireDefaultEnvironment(): Promise<void> {
  const refusal = "deploy_environment_refused:CLOUDFLARE_ENV";
  if (process.env.CLOUDFLARE_ENV !== undefined) throw new Error(refusal);
  // Wrangler also loads system variables from root dotenv files. Refuse the
  // selector there without logging values or changing authentication variables.
  for (const file of [".env", ".env.local"]) {
    let contents: string;
    try { contents = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (/^\s*(?:export\s+)?CLOUDFLARE_ENV(?:\s*=|:\s)/m.test(contents)) throw new Error(refusal);
  }
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
