import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E2E_BOOTSTRAP_TOKEN,
  E2E_PORT,
} from "../apps/web/e2e/support/constants";

const repositoryRoot = process.cwd();
const webRoot = join(repositoryRoot, "apps", "web");
const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-e2e-"));
const emptyDotenvPath = join(temporaryRoot, "empty.env");
await writeFile(emptyDotenvPath, "", { mode: 0o600 });

if (
  !Number.isSafeInteger(E2E_PORT)
  || E2E_PORT < 1_024
  || E2E_PORT > 65_535
) {
  throw new Error("FRAME_OF_MIND_E2E_PORT must be an integer from 1024 to 65535.");
}

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
  activeChild = Bun.spawn(
    ["bun", "x", "nuxi", "build", "--dotenv", emptyDotenvPath],
    {
      cwd: webRoot,
      env: environment,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const buildExitCode = await activeChild.exited;
  if (buildExitCode !== 0) {
    process.exitCode = buildExitCode;
  } else {
    activeChild = Bun.spawn(["bun", ".output/server/index.mjs"], {
      cwd: webRoot,
      env: environment,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    console.log(
      `Synthetic Studio E2E server listening on http://127.0.0.1:${E2E_PORT}`,
    );
    process.exitCode = await activeChild.exited;
  }
} finally {
  activeChild = undefined;
  await rm(temporaryRoot, { recursive: true, force: true });
}
