import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";

type Mode = "fresh" | "upgrade" | "install-only";

const mode = parseMode(Bun.argv[2]);
const sourceRoot = await gitOutput(["rev-parse", "--show-toplevel"], process.cwd());
const headSha = await gitOutput(["rev-parse", "HEAD"], sourceRoot);
const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-fresh-clone-"));
const checkoutRoot = join(temporaryRoot, "checkout");
const stateRoot = join(temporaryRoot, "state");
const databasePath = join(stateRoot, "studio.sqlite");

try {
  if (mode === "upgrade") {
    await runUpgrade();
  } else {
    await cloneHead();
    await installAndBuild(checkoutRoot);
    await verifyCliHelp(checkoutRoot);
    if (mode === "install-only") {
      console.log("FRESH_CLONE install=PASS build=PASS studio_boot=SKIP");
    } else {
      await bootAndProbeStudio(checkoutRoot, databasePath, true);
      verifyCurrentSchema(databasePath);
      console.log("FRESH_CLONE install=PASS build=PASS studio_boot=PASS");
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runUpgrade(): Promise<void> {
  const upgradeFrom = await resolveUpgradeBase();
  console.log(`Upgrade base: ${upgradeFrom.label}`);
  await run(
    ["git", "clone", "--no-checkout", pathToFileURL(sourceRoot).href, checkoutRoot],
    temporaryRoot,
  );
  await run(["git", "switch", "--create", "fresh-clone-upgrade", upgradeFrom.sha], checkoutRoot);
  await run(["bun", "install", "--frozen-lockfile"], checkoutRoot);
  await run(["bun", "run", "build:web"], checkoutRoot, studioBuildEnvironment());
  await bootAndProbeStudio(checkoutRoot, databasePath, false);

  await run(["git", "merge", "--ff-only", headSha], checkoutRoot);
  await installAndBuild(checkoutRoot);
  await verifyCliHelp(checkoutRoot);
  await bootAndProbeStudio(checkoutRoot, databasePath, true);
  verifyCurrentSchema(databasePath);
  console.log("UPGRADE install=PASS build=PASS studio_boot=PASS migration=PASS");
}

async function cloneHead(): Promise<void> {
  await run(
    [
      "git",
      "clone",
      "--depth",
      "1",
      "--no-tags",
      pathToFileURL(sourceRoot).href,
      checkoutRoot,
    ],
    temporaryRoot,
  );
  const clonedHead = await gitOutput(["rev-parse", "HEAD"], checkoutRoot);
  if (clonedHead !== headSha) {
    throw new Error(`Fresh clone resolved ${clonedHead}, expected ${headSha}.`);
  }
}

async function installAndBuild(root: string): Promise<void> {
  await installFrozen(root);
  await run(["bun", "run", "build:cli"], root);
  await run(["bun", "run", "build:web"], root, studioBuildEnvironment());
}

async function installFrozen(root: string): Promise<void> {
  const diagnostic = process.env.FRAME_OF_MIND_LOCKFILE_DIAGNOSTIC === "1";
  try {
    await run([
      "bun",
      "install",
      "--frozen-lockfile",
      ...(diagnostic ? ["--verbose"] : []),
    ], root);
  } catch (error) {
    if (diagnostic) {
      console.error("WINDOWS_LOCKFILE_DIAGNOSTIC frozen_install=FAIL");
      await run(["bun", "install", "--lockfile-only", "--verbose"], root);
      await run(["git", "diff", "--", "bun.lock"], root);
    }
    throw error;
  }
}

async function verifyCliHelp(root: string): Promise<void> {
  const output = await runCaptured(["bun", "dist/cli.js", "--help"], root);
  if (!output.includes("Usage:")) {
    throw new Error("Built CLI --help did not print its usage contract.");
  }
}

async function bootAndProbeStudio(
  root: string,
  sqlitePath: string,
  requireLaunchPage: boolean,
): Promise<void> {
  const port = reserveRandomPort();
  const origin = `http://127.0.0.1:${port}`;
  const bootstrapToken = randomBytes(32).toString("base64url");
  const launchPath = requireLaunchPage ? "/__studio/launch" : "/";
  const launchUrl = `${origin}${launchPath}#studio-bootstrap=${encodeURIComponent(bootstrapToken)}`;
  const environment = studioRuntimeEnvironment({
    bootstrapToken,
    databasePath: sqlitePath,
    port,
    root,
  });
  const webRoot = join(root, "apps", "web");
  const sentryPreload = join(webRoot, ".output", "server", "sentry.server.config.mjs");
  const serverEntry = join(webRoot, ".output", "server", "index.mjs");
  const serverCommand = existsSync(sentryPreload)
    ? ["bun", "--preload", sentryPreload, serverEntry]
    : ["bun", serverEntry];
  const server = Bun.spawn(serverCommand, {
    cwd: webRoot,
    env: environment,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });

  try {
    await waitForStudioReadiness(server, origin);

    const launchResponse = await fetch(launchUrl, { redirect: "manual" });
    if (launchResponse.status !== 200) {
      throw new Error(`One-time Studio launch returned HTTP ${launchResponse.status}.`);
    }

    const exchange = await fetch(`${origin}/__studio/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ token: bootstrapToken }),
    });
    if (exchange.status !== 200) {
      throw new Error(`One-time Studio exchange returned HTTP ${exchange.status}.`);
    }
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("One-time Studio exchange did not set a session cookie.");

    const composer = await fetch(`${origin}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    if (composer.status !== 200) {
      throw new Error(`Authenticated composer readiness returned HTTP ${composer.status}.`);
    }
  } finally {
    await stop(server);
  }
}

async function waitForStudioReadiness(
  server: Bun.Subprocess,
  origin: string,
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Local Studio exited before readiness with code ${server.exitCode}.`);
    }
    try {
      const response = await fetch(`${origin}/api/studio/session`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 401) return;
    } catch {
      // Listener is not ready yet.
    }
    await Bun.sleep(200);
  }
  throw new Error("Local Studio did not become ready on its random loopback port.");
}

function verifyCurrentSchema(path: string): void {
  const database = new Database(path);
  try {
    const projectionColumns = database.query<{ name: string }, []>(
      "PRAGMA table_info(analysis_runs)",
    ).all();
    if (!projectionColumns.some((column) => column.name === "principal_sub")) {
      throw new Error("Local projection schema did not migrate to principal scope.");
    }
    const jobMigration = database.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'studio_job_schema_migrations'",
    ).get();
    if (!jobMigration) {
      throw new Error("Local Studio job schema was not initialized on boot.");
    }
  } finally {
    database.close();
  }
}

async function resolveUpgradeBase(): Promise<{ label: string; sha: string }> {
  const explicit = process.env.FRAME_OF_MIND_UPGRADE_FROM;
  if (explicit) {
    return {
      label: explicit,
      sha: await gitOutput(["rev-parse", `${explicit}^{commit}`], sourceRoot),
    };
  }

  const tag = await tryGitOutput(
    ["describe", "--tags", "--abbrev=0", `${headSha}^`],
    sourceRoot,
  );
  if (tag) {
    return {
      label: tag,
      sha: await gitOutput(["rev-parse", `${tag}^{commit}`], sourceRoot),
    };
  }

  const mergeBase = await tryGitOutput(
    ["merge-base", headSha, "origin/main"],
    sourceRoot,
  );
  if (mergeBase && mergeBase !== headSha) {
    return { label: `merge-base:${mergeBase.slice(0, 12)}`, sha: mergeBase };
  }
  throw new Error(
    "Upgrade mode requires a previous tag, a non-HEAD origin/main merge-base, "
    + "or FRAME_OF_MIND_UPGRADE_FROM.",
  );
}

function studioBuildEnvironment(): Record<string, string | undefined> {
  return {
    ...sanitizedEnvironment(),
    FRAME_OF_MIND_STUDIO: "1",
  };
}

function studioRuntimeEnvironment(input: {
  bootstrapToken: string;
  databasePath: string;
  port: number;
  root: string;
}): Record<string, string | undefined> {
  return {
    ...studioBuildEnvironment(),
    FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN: input.bootstrapToken,
    FRAME_OF_MIND_CHECKOUT_ROOT: input.root,
    FRAME_OF_MIND_MEDIA_ROOT: join(stateRoot, "media"),
    FRAME_OF_MIND_CONTEXT_ROOT: join(stateRoot, "context"),
    FRAME_OF_MIND_OUTPUT: join(stateRoot, "runs"),
    FRAME_OF_MIND_MAINTENANCE_INTERVAL_MS: "0",
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
    PORT: String(input.port),
    NITRO_PORT: String(input.port),
    NUXT_SQLITE_PATH: input.databasePath,
    XDG_CONFIG_HOME: join(stateRoot, "config"),
    NITRO_UNIX_SOCKET: undefined,
  };
}

function sanitizedEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env };
  for (const key of [
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "GRANOLA_API_KEY",
    "BLUEDOT_MCP_URL",
    "GRANOLA_MCP_URL",
    "FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN",
    "FRAME_OF_MIND_DB_DRIVER",
    "FRAME_OF_MIND_HOSTED_WORKFLOWS",
    "FRAME_OF_MIND_HOSTED_WORKFLOW_SPIKE",
    "FRAME_OF_MIND_STUDIO_SPIKE",
    "NUXT_SQLITE_PATH",
    "NITRO_PRESET",
    "NITRO_UNIX_SOCKET",
    "HOST",
    "PORT",
  ]) {
    delete environment[key];
  }
  return environment;
}

function reserveRandomPort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 }),
  });
  const port = reservation.port;
  reservation.stop(true);
  if (!port) throw new Error("Bun did not allocate a random loopback port.");
  return port;
}

async function stop(process: Bun.Subprocess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  const stopped = await Promise.race([
    process.exited.then(() => true),
    Bun.sleep(10_000).then(() => false),
  ]);
  if (!stopped && process.exitCode === null) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const value = await tryGitOutput(args, cwd);
  if (!value) throw new Error(`git ${args.join(" ")} returned no output.`);
  return value;
}

async function tryGitOutput(args: string[], cwd: string): Promise<string | undefined> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    env: sanitizedEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(process.stdout).text();
  return await process.exited === 0 ? output.trim() || undefined : undefined;
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined> = sanitizedEnvironment(),
): Promise<void> {
  console.log(`$ ${command.join(" ")}`);
  const process = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit code ${exitCode}.`);
  }
}

async function runCaptured(command: string[], cwd: string): Promise<string> {
  console.log(`$ ${command.join(" ")}`);
  const process = Bun.spawn(command, {
    cwd,
    env: sanitizedEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(process.stdout).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit code ${exitCode}.`);
  }
  return output;
}

function parseMode(value: string | undefined): Mode {
  if (!value || value === "fresh") return "fresh";
  if (value === "upgrade" || value === "install-only") return value;
  throw new Error("Usage: bun scripts/test-fresh-clone.ts [fresh|upgrade|install-only]");
}
