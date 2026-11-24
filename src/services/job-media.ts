import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, read, write } from "node:fs";
import { promisify } from "node:util";
import { openJobFile } from "../adapters/job-path.js";

import { ContractError, faultCode } from "../domain/contract-error.js";
import { runMediaTool } from "./media-tools.js";

const pread = promisify(read);
const pwrite = promisify(write);

export async function probeJobMedia(file: number): Promise<number> {
  try {
    // fd: can seek through the held recording. No file or network protocol is
    // available for a playlist, external track or other secondary input.
    const result = await runMediaTool("ffprobe", ["-protocol_whitelist", "fd", "-format_whitelist", "mov,matroska,webm",
      "-select_streams", "V:0", "-show_entries", "stream=codec_type:format=duration,format_name", "-of", "json", "fd:"],
    {inputFd: file, maxOutput: 16384});
    const {streams, format} = JSON.parse(result);
    const duration = Number(format.duration);
    if (streams[0]?.codec_type === "video" && Number.isFinite(duration) && duration > 0) return duration;
  } catch (error) {
    if (faultCode(error) === "CAPABILITY_MISSING") throw error;
  }
  throw new ContractError("INVALID_INPUT", "Could not verify the selected recording.");
}

/** Read only the admitted length using positioned reads on the held file.
 * Optionally seal exactly those bytes in a new, private job-owned file. */
export async function digestJobMedia(file: number, size: number, destination?: string, created?: (identity: string) => void) {
  const target = destination === undefined ? undefined : openJobFile(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    if (target !== undefined && created) {
      const stat = fstatSync(target, {bigint: true});
      created([stat.dev, stat.ino, stat.birthtimeNs].join("/"));
    }
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
    for (let offset = 0; offset < size;) {
      const {bytesRead} = await pread(file, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw new ContractError("CONFLICT", "Recording changed during admission.");
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      if (target !== undefined) {
        let written = 0;
        while (written < bytesRead) {
          const chunk = await pwrite(target, bytes, written, bytesRead - written, offset + written);
          if (!chunk.bytesWritten) throw new ContractError("COMMAND_FAILED", "Failed to seal job input.");
          written += chunk.bytesWritten;
        }
      }
      offset += bytesRead;
    }
    return digest.digest("hex");
  } finally { if (target !== undefined) closeSync(target); }
}
