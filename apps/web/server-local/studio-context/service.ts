import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  ContextFileStagingError,
  LocalContextFileStagingAdapter,
} from "./local-context-staging.js";

const contextRootEnvironmentVariable = "FRAME_OF_MIND_CONTEXT_ROOT";
let configuredAdapter: Promise<LocalContextFileStagingAdapter> | undefined;

export function resolveLocalContextRoot(
  environment: NodeJS.ProcessEnv = process.env,
  operatingSystem = platform(),
): string {
  const override = environment[contextRootEnvironmentVariable]?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new ContextFileStagingError(
        "unsafe_staging_root",
        `${contextRootEnvironmentVariable} must be an absolute path.`,
      );
    }
    return resolve(override);
  }

  if (operatingSystem === "win32") {
    const localAppData = environment.LOCALAPPDATA
      || join(homedir(), "AppData", "Local");
    return join(localAppData, "Frame of Mind", "staging", "context");
  }
  if (operatingSystem === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Frame of Mind",
      "staging",
      "context",
    );
  }
  const dataHome = environment.XDG_DATA_HOME
    || join(homedir(), ".local", "share");
  return join(dataHome, "frame-of-mind", "staging", "context");
}

export function getLocalContextFileStaging():
  Promise<LocalContextFileStagingAdapter> {
  configuredAdapter ??= (async () => {
    const adapter = new LocalContextFileStagingAdapter({
      rootDirectory: resolveLocalContextRoot(),
      checkoutRoot: process.env.FRAME_OF_MIND_CHECKOUT_ROOT,
    });
    await adapter.expire();
    return adapter;
  })();
  return configuredAdapter;
}

export function resetLocalContextFileStagingForTests(): void {
  configuredAdapter = undefined;
}
