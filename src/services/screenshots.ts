import { spawn } from "node:child_process";
import { access, chmod, rm } from "node:fs/promises";
import { timestampToSeconds } from "../lib/time.js";

export async function extractScreenshot(video: string, timestamp: string | undefined, destination: string): Promise<boolean> {
  const seconds = Math.max(0, timestampToSeconds(timestamp));
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(seconds), "-i", video,
      "-frames:v", "1", "-q:v", "2", destination,
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
