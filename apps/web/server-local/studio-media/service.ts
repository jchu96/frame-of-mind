import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  LocalMediaStagingAdapter,
  MediaStagingError,
} from "./local-media-staging.js";

const mediaRootEnvironmentVariable = "FRAME_OF_MIND_MEDIA_ROOT";
let configuredAdapter: Promise<LocalMediaStagingAdapter> | undefined;

export function resolveLocalMediaRoot(
  environment: NodeJS.ProcessEnv = process.env,
  operatingSystem = platform(),
): string {
  const override = environment[mediaRootEnvironmentVariable]?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new MediaStagingError(
        "unsafe_staging_root",
        `${mediaRootEnvironmentVariable} must be an absolute path.`,
      );
    }
    return resolve(override);
  }

  if (operatingSystem === "win32") {
    const localAppData = environment.LOCALAPPDATA
      || join(homedir(), "AppData", "Local");
    return join(localAppData, "Frame of Mind", "staging", "media");
  }
  if (operatingSystem === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Frame of Mind",
      "staging",
      "media",
    );
  }
  const dataHome = environment.XDG_DATA_HOME
    || join(homedir(), ".local", "share");
  return join(dataHome, "frame-of-mind", "staging", "media");
}

export function getLocalMediaStaging(): Promise<LocalMediaStagingAdapter> {
  configuredAdapter ??= Promise.resolve(
    new LocalMediaStagingAdapter({
      rootDirectory: resolveLocalMediaRoot(),
      checkoutRoot: process.env.FRAME_OF_MIND_CHECKOUT_ROOT,
    }),
  );
  return configuredAdapter;
}

export function resetLocalMediaStagingForTests(): void {
  configuredAdapter = undefined;
}
