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

console.log("Frame of Mind Studio is starting on loopback.");
console.log(`Open this one-time launch URL:\n${launchUrl}`);
console.log("The URL fragment is removed before the capability is exchanged.");

const child = Bun.spawn(["bun", "run", "--cwd", "apps/web", "dev"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    FRAME_OF_MIND_STUDIO: "1",
    FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN: bootstrapToken,
    PORT: String(configuredPort),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

const exitCode = await child.exited;
process.exit(exitCode);
