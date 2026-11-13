import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultOutputRoot(): string {
  if (process.env.FRAME_OF_MIND_OUTPUT) return resolve(process.env.FRAME_OF_MIND_OUTPUT);
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "frame-of-mind", "runs");
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "frame-of-mind", "runs");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "frame-of-mind", "runs");
}

export function defaultAppDataRoot(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "frame-of-mind");
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "frame-of-mind");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "frame-of-mind");
}
