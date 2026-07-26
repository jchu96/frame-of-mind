import { generateStudioCapability } from "../apps/web/server-local/studio-session/session.js";
import { LOCAL_STUDIO_BOOTSTRAP_FRAGMENT } from "../apps/web/server-local/studio-session/contract.js";

const configuredPort = Number(process.env.PORT || 3_000);
if (
  !Number.isSafeInteger(configuredPort)
  || configuredPort < 1_024
  || configuredPort > 65_535
) {
  throw new Error("PORT must be an integer from 1024 to 65535.");
}

const bootstrapToken = generateStudioCapability();
const launchUrl =
  `http://127.0.0.1:${configuredPort}/${LOCAL_STUDIO_BOOTSTRAP_FRAGMENT}`
  + encodeURIComponent(bootstrapToken);
const studioEnvironment = {
  ...process.env,
  FRAME_OF_MIND_STUDIO: "1",
  FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN: bootstrapToken,
  HOST: "127.0.0.1",
  NITRO_HOST: "127.0.0.1",
  PORT: String(configuredPort),
};
let activeChild: Bun.Subprocess | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => activeChild?.kill(signal));
}

console.log("Building Frame of Mind Studio for the local Bun runtime...");
activeChild = Bun.spawn(["bun", "run", "--cwd", "apps/web", "build"], {
  cwd: process.cwd(),
  env: studioEnvironment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const buildExitCode = await activeChild.exited;
if (buildExitCode !== 0) process.exit(buildExitCode);

activeChild = Bun.spawn(["bun", "run", "--cwd", "apps/web", "preview"], {
  cwd: process.cwd(),
  env: studioEnvironment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let ready = false;
for (let attempt = 0; attempt < 150; attempt += 1) {
  if (activeChild.exitCode !== null) break;
  try {
    const response = await fetch(
      `http://127.0.0.1:${configuredPort}/api/studio/session`,
      { signal: AbortSignal.timeout(500) },
    );
    if (response.status === 401) {
      ready = true;
      break;
    }
  } catch {
    // The listener is not ready yet.
  }
  await Bun.sleep(200);
}

if (!ready) {
  activeChild.kill("SIGTERM");
  await activeChild.exited;
  throw new Error("Local Studio did not become ready on the loopback listener.");
}

console.log("Frame of Mind Studio is ready on loopback.");
console.log(`Open this one-time launch URL:\n${launchUrl}`);
console.log("The URL fragment is removed before the capability is exchanged.");

const exitCode = await activeChild.exited;
process.exit(exitCode);
