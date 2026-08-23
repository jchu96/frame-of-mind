import { createE2EEnvironment } from "./e2e-environment";
import { createE2EIsolation } from "../apps/web/e2e/support/isolation";

const suite = process.env.FRAME_OF_MIND_E2E_SUITE || "smoke";
const isolation = await createE2EIsolation(`playwright-${suite}`);
const e2ePort = await isolation.reservePort();
const canaryEnvironment = suite === "canary" || suite === "all"
  ? Object.fromEntries([
      "FRAME_OF_MIND_CANARY_URL",
      "CF_ACCESS_CLIENT_ID",
      "CF_ACCESS_CLIENT_SECRET",
    ].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []))
  : {};
const environment = createE2EEnvironment(process.env, {
  FRAME_OF_MIND_E2E_TEMP_ROOT: isolation.root,
  FRAME_OF_MIND_E2E_PORT: String(e2ePort),
  FRAME_OF_MIND_E2E_SUITE: suite,
  FRAME_OF_MIND_E2E_RUN_ID: isolation.id,
  ...canaryEnvironment,
});

// These prove that neither arbitrary parent variables nor provider credentials
// cross the sanitized Playwright process boundary.
process.env.FRAME_OF_MIND_E2E_SECRET_CANARY = "must-not-cross-e2e-boundary";
process.env.GEMINI_API_KEY = "synthetic-parent-key-must-not-cross";

let activeChild: Bun.Subprocess | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    activeChild?.kill(signal);
  });
}

try {
  activeChild = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "x",
      "playwright",
      "test",
      ...process.argv.slice(2),
    ],
    {
      cwd: process.cwd(),
      env: environment,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exitCode = await activeChild.exited;
} finally {
  activeChild = undefined;
  await isolation.cleanup();
}
