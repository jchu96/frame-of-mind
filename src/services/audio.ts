import { spawn } from "node:child_process";
import { access, chmod, rm } from "node:fs/promises";

/**
 * Extracts the first audio stream from a local recording into an ADTS AAC
 * file suitable for a Gemini `audio/aac` upload. Mirrors the screenshot
 * extractor contract: never throws, returns false when ffmpeg is missing,
 * the recording has no audio track, or the derivative was not produced.
 */
export async function extractAudioTrack(video: string, destination: string): Promise<boolean> {
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", video,
      "-vn", "-map", "0:a:0", "-map_metadata", "-1",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
      "-f", "adts", destination,
    ], { stdio: "ignore" });
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  if (code !== 0) return false;
  try {
    await access(destination);
    await chmod(destination, 0o600);
    return true;
  } catch {
    await rm(destination, { force: true });
    return false;
  }
}
