import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { buildContentHash } from "./check-build-cache";

// 2026-11-13: unchanged-base hosted failures moved this lane out of the PR gate.
// Review found writable success receipts could bypass both gates. Deploy is now
// only a continuation of successful checks in this process. Retire this wrapper
// when an enforced deployment pipeline proves hosted coverage for its exact source.
const mode = process.argv[2];
if (mode !== "check" && mode !== "deploy") throw new Error("Use check or deploy.");

try {
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
  // Do not forward unknown spellings to a second argument parser. Canonicalize
  // this small supported surface; in particular no form of cwd reaches Wrangler.
  for (const arg of args) {
    if (/^--?cwd(?:=|$)/.test(arg)) throw new Error(`deploy_argument_refused:${arg}`);
  }
  const parsed = parseArgs({
    args: args.map((arg) => arg.startsWith("-c=") ? `--config=${arg.slice(3)}` : arg),
    allowPositionals: true, tokens: true,
    options: {
      config: { type: "string", short: "c" },
      assets: { type: "string" }, site: { type: "string" }, script: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  if (parsed.positionals.length > 1) throw new Error("deploy_argument_refused:multiple_entrypoints");
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
  const forwarded: string[] = [];
  for (const token of parsed.tokens) {
    if (token.kind === "option") {
      if (token.name === "dry-run") forwarded.push("--dry-run");
      else forwarded.push(`--${token.name}`, await inside(token.value!, args[token.index]!));
    }
  }
  const configPath = await inside(parsed.values.config ?? "wrangler.jsonc", "--config");
  // Explicit config prevents Wrangler discovering a parent repo's configuration.
  if (!parsed.values.config) forwarded.push("--config", configPath);
  const { experimental_readRawConfig } = createRequire(resolve("apps/web/package.json"))("wrangler");
  let config;
  try { config = experimental_readRawConfig({ config: configPath }).rawConfig; }
  catch { throw new Error("deploy_argument_invalid:--config"); }
  for (const [field, path] of [
    ["main", config.main], ["assets.directory", config.assets?.directory], ["site.bucket", config.site?.bucket],
  ]) {
    if (path !== undefined) await inside(resolve(dirname(configPath), path), `--config:${field}`);
  }
  // The separator prevents a positional filename from becoming a Wrangler flag.
  for (const path of parsed.positionals) forwarded.push("--", await inside(path, path));
  return forwarded;
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
