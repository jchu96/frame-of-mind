import { spawn } from "node:child_process";
import { access, chmod, rm } from "node:fs/promises";

const AUDIO_EXTRACTION_TIMEOUT_MS = 10 * 60_000;

export interface ExtractAudioTrackOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Extracts the first audio stream from a local recording into an ADTS AAC
 * file suitable for a Gemini `audio/aac` upload. Mirrors the screenshot
 * extractor contract: never throws, returns false when ffmpeg is missing,
 * the recording has no audio track, extraction is aborted or times out, or
 * the derivative was not produced.
 */
export async function extractAudioTrack(
  video: string,
  destination: string,
  options: ExtractAudioTrackOptions = {},
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", video,
      "-vn", "-map", "0:a:0", "-map_metadata", "-1",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
      "-f", "adts", destination,
    ], { stdio: "ignore" });
    const kill = () => child.kill("SIGKILL");
    const timeout = setTimeout(kill, options.timeoutMs ?? AUDIO_EXTRACTION_TIMEOUT_MS);
    options.signal?.addEventListener("abort", kill, { once: true });
    const settle = (result: number | null) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", kill);
      resolve(result);
    };
    child.once("error", () => settle(null));
    child.once("close", settle);
  });
  if (code !== 0) {
    await rm(destination, { force: true });
    return false;
  }
  try {
    await access(destination);
    await chmod(destination, 0o600);
    return true;
  } catch {
    await rm(destination, { force: true });
    return false;
  }
}
