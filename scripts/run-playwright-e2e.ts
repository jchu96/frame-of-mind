import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2EEnvironment } from "./e2e-environment";

const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-e2e-"));
const environment = createE2EEnvironment(process.env, {
  FRAME_OF_MIND_E2E_TEMP_ROOT: temporaryRoot,
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
  await rm(temporaryRoot, { recursive: true, force: true });
}
