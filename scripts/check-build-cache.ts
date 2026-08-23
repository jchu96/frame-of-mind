import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const inheritedBuildEnvironment = ["PATH", "HOME", "TMPDIR", "CI"] as const;

export function scrubBuildEnvironment(
  additions: Record<string, string>,
  caller: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of inheritedBuildEnvironment) {
    const value = caller[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...additions };
}

export async function buildContentHash(
  cwd: string,
  environment: Record<string, string>,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("environment\0");
  for (const [name, value] of Object.entries(environment).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    hash.update(name);
    hash.update("=");
    hash.update(value);
    hash.update("\0");
  }
  hash.update("files\0");
  for (const path of await buildInputPaths(cwd)) {
    hash.update(path);
    hash.update("\0");
    try {
      hash.update(await readFile(resolve(cwd, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("<deleted>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function buildInputPaths(cwd: string): Promise<string[]> {
  const child = spawn("git", [
    "ls-files", "-z", "--cached", "--others", "--exclude-standard",
  ], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`Could not enumerate build inputs: ${stderr.trim()}`);
  }
  const paths = Buffer.concat(stdout).toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"))
    .filter(isBuildInputPath);
  return [...new Set(paths)].sort();
}

export function isBuildInputPath(path: string): boolean {
  return !/(^|\/)(?:node_modules|\.nuxt|\.output)(?:\/|$)/.test(path)
    && !path.startsWith("docs/")
    && !path.startsWith("conductor/")
    && !path.endsWith(".md")
    && !path.startsWith("apps/web/e2e/__screenshots__/");
}
