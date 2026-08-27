import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const repositoryHooksPath = "tools/git-hooks";

type Reporter = (message: string) => void;

export function installGitHooks(
  workingDirectory: string,
  report: Reporter = console.log,
  reportError: Reporter = console.error,
): number {
  const repositoryRootResult = git(workingDirectory, ["rev-parse", "--show-toplevel"]);
  if (repositoryRootResult.exitCode !== 0) {
    reportError("Could not find the Git repository root.");
    return 1;
  }
  const repositoryRoot = repositoryRootResult.stdout.trim();
  const configuredPathResult = git(repositoryRoot, ["config", "--get", "core.hooksPath"]);
  if (configuredPathResult.exitCode !== 0 && configuredPathResult.exitCode !== 1) {
    reportError("Could not read the repository's core.hooksPath setting.");
    return 1;
  }

  const configuredPath = configuredPathResult.stdout.trim();
  if (configuredPath && !pointsToRepositoryHooks(repositoryRoot, configuredPath)) {
    reportError(`Refusing to replace existing core.hooksPath: ${configuredPath}`);
    reportError(
      "Inspect its source with `git config --show-origin --get core.hooksPath`, then keep or "
      + "migrate those hooks and unset the setting in its owning scope before retrying "
      + "`bun run hooks:install` (for a repository-local value, use "
      + "`git config --local --unset core.hooksPath`).",
    );
    return 1;
  }

  const configureResult = git(repositoryRoot, [
    "config",
    "--local",
    "core.hooksPath",
    repositoryHooksPath,
  ]);
  if (configureResult.exitCode !== 0) {
    reportError("Could not configure the repository's core.hooksPath setting.");
    return 1;
  }
  report(`Git hooks installed from ${repositoryHooksPath}.`);
  return 0;
}

async function runSelfTest(): Promise<void> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-hooks-install-"));
  try {
    assertGit(fixtureRoot, ["init", "--quiet"]);

    const installedMessages: string[] = [];
    if (installGitHooks(fixtureRoot, (message) => installedMessages.push(message)) !== 0) {
      throw new Error("Git-hooks installer self-test failed to install an unset hooks path.");
    }
    assertConfiguredPath(fixtureRoot, repositoryHooksPath);

    assertGit(fixtureRoot, ["config", "--local", "core.hooksPath", "./tools/git-hooks"]);
    if (installGitHooks(fixtureRoot, () => {}) !== 0) {
      throw new Error("Git-hooks installer self-test rejected the repository hooks path.");
    }
    assertConfiguredPath(fixtureRoot, repositoryHooksPath);

    assertGit(fixtureRoot, ["config", "--local", "core.hooksPath", "custom-hooks"]);
    const refusalMessages: string[] = [];
    if (installGitHooks(fixtureRoot, () => {}, (message) => refusalMessages.push(message)) === 0) {
      throw new Error("Git-hooks installer self-test replaced an existing hooks path.");
    }
    assertConfiguredPath(fixtureRoot, "custom-hooks");
    if (
      !refusalMessages.some((message) => message.includes("custom-hooks"))
      || !refusalMessages.some((message) => message.includes("git config --show-origin"))
      || !refusalMessages.some((message) => message.includes("git config --local --unset"))
    ) {
      throw new Error("Git-hooks installer self-test did not explain how to resolve refusal.");
    }

    console.log("Git-hooks installer self-test: passed (3 fixtures).");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function pointsToRepositoryHooks(repositoryRoot: string, configuredPath: string): boolean {
  const absoluteConfiguredPath = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(repositoryRoot, configuredPath);
  return absoluteConfiguredPath === resolve(repositoryRoot, repositoryHooksPath);
}

function assertConfiguredPath(repositoryRoot: string, expected: string): void {
  const result = git(repositoryRoot, ["config", "--local", "--get", "core.hooksPath"]);
  if (result.exitCode !== 0 || result.stdout.trim() !== expected) {
    throw new Error(
      `Git-hooks installer self-test expected ${JSON.stringify(expected)}; `
      + `received ${JSON.stringify(result.stdout.trim())}.`,
    );
  }
}

function assertGit(workingDirectory: string, args: string[]): void {
  const result = git(workingDirectory, args);
  if (result.exitCode !== 0) {
    throw new Error(`Git-hooks installer self-test command failed: git ${args.join(" ")}`);
  }
}

function git(
  workingDirectory: string,
  args: string[],
): { readonly exitCode: number; readonly stdout: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: workingDirectory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

if (import.meta.main) {
  if (process.argv[2] === "--self-test") {
    await runSelfTest();
  } else if (process.argv.length === 2) {
    process.exitCode = installGitHooks(process.cwd());
  } else {
    throw new Error("Usage: install-git-hooks.ts [--self-test]");
  }
}
