import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  E2E_BOOTSTRAP_TOKEN,
  E2E_PORT,
} from "../apps/web/e2e/support/constants";
import { withE2EBuildLock } from "../apps/web/e2e/support/isolation";
import { resolvePrebuiltWebOutput } from "./prebuilt-artifact";

const repositoryRoot = process.cwd();
const webRoot = join(repositoryRoot, "apps", "web");

if (
  !Number.isSafeInteger(E2E_PORT)
  || E2E_PORT < 1_024
  || E2E_PORT > 65_535
) {
  throw new Error("FRAME_OF_MIND_E2E_PORT must be an integer from 1024 to 65535.");
}

const configuredTemporaryRoot = process.env.FRAME_OF_MIND_E2E_TEMP_ROOT;
const resolvedTemporaryRoot = configuredTemporaryRoot
  ? resolve(configuredTemporaryRoot)
  : undefined;
if (
  resolvedTemporaryRoot
  && (
    dirname(resolvedTemporaryRoot) !== resolve(tmpdir())
    || !basename(resolvedTemporaryRoot).startsWith("frame-of-mind-e2e-")
  )
) {
  throw new Error(
    "FRAME_OF_MIND_E2E_TEMP_ROOT must be a managed directory under the OS temp root.",
  );
}
const ownsTemporaryRoot = resolvedTemporaryRoot === undefined;
const temporaryRoot = resolvedTemporaryRoot
  ?? await mkdtemp(join(tmpdir(), "frame-of-mind-e2e-"));
const emptyDotenvPath = join(temporaryRoot, "empty.env");
const prebuiltOutput = await resolvePrebuiltWebOutput("node-server");
const isolatedOutput = prebuiltOutput ?? join(temporaryRoot, "local-web-output");

const environment: Record<string, string> = {
  HOME: temporaryRoot,
  USERPROFILE: temporaryRoot,
  APPDATA: join(temporaryRoot, "appdata"),
  LOCALAPPDATA: join(temporaryRoot, "localappdata"),
  TMPDIR: temporaryRoot,
  TEMP: temporaryRoot,
  TMP: temporaryRoot,
  FRAME_OF_MIND_DB_DRIVER: "sqlite",
  FRAME_OF_MIND_STUDIO: "1",
  FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN: E2E_BOOTSTRAP_TOKEN,
  FRAME_OF_MIND_CHECKOUT_ROOT: repositoryRoot,
  HOST: "127.0.0.1",
  NITRO_HOST: "127.0.0.1",
  PORT: String(E2E_PORT),
  NITRO_PORT: String(E2E_PORT),
  NUXT_SQLITE_PATH: join(temporaryRoot, "studio.sqlite"),
  XDG_CONFIG_HOME: join(temporaryRoot, "config"),
  BLUEDOT_MCP_URL: "https://e2e.invalid/bluedot/mcp",
  GRANOLA_MCP_URL: "https://e2e.invalid/granola/mcp",
};
for (const name of ["PATH", "CI", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
  const value = process.env[name];
  if (value) environment[name] = value;
}

let activeChild: Bun.Subprocess | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    activeChild?.kill(signal);
  });
}

try {
  await writeFile(emptyDotenvPath, "", { mode: 0o600 });
  const buildExitCode = prebuiltOutput
    ? 0
    : await withE2EBuildLock(async () => {
      activeChild = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "x",
        "nuxi",
        "build",
        "--dotenv",
        emptyDotenvPath,
      ],
      {
        cwd: webRoot,
        env: environment,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
      const exitCode = await activeChild.exited;
      if (exitCode === 0) {
        await cp(join(webRoot, ".output"), isolatedOutput, { recursive: true });
      }
      return exitCode;
    });
  if (prebuiltOutput) {
    console.log("STUDIO_E2E build=SKIP prebuilt=node-server");
  }
  if (buildExitCode !== 0) {
    process.exitCode = buildExitCode;
  } else {
    activeChild = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        join(isolatedOutput, "server/sentry.server.config.mjs"),
        join(isolatedOutput, "server/index.mjs"),
      ],
      {
        cwd: webRoot,
        env: environment,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    console.log(
      `Synthetic Studio E2E server listening on http://127.0.0.1:${E2E_PORT}`,
    );
    process.exitCode = await activeChild.exited;
  }
} finally {
  activeChild = undefined;
  if (ownsTemporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
