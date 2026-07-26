import { tmpdir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export const MAX_SPIKE_BYTES = 128 * 1_024 * 1_024;

export function spikePaths(): {
  directory: string;
  partial: string;
  sealed: string;
} {
  const configured = process.env.FRAME_OF_MIND_STUDIO_SPIKE_DIR;
  if (!configured || !isAbsolute(configured)) {
    throw new Error(
      "FRAME_OF_MIND_STUDIO_SPIKE_DIR must be an explicit absolute path.",
    );
  }
  const directory = resolve(configured);
  const temporaryRoot = resolve(tmpdir());
  const relativeDirectory = relative(temporaryRoot, directory);
  if (
    !relativeDirectory
    || relativeDirectory.startsWith("..")
    || isAbsolute(relativeDirectory)
    || !basename(directory).startsWith("frame-of-mind-studio-spike-")
  ) {
    throw new Error(
      "FRAME_OF_MIND_STUDIO_SPIKE_DIR must be a dedicated Frame of Mind directory under the OS temporary directory.",
    );
  }
  return {
    directory,
    partial: join(directory, "stream-upload.partial"),
    sealed: join(directory, "stream-upload.sealed"),
  };
}
