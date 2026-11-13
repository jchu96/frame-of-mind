// Shared import point only; callers must still pass childEnvironment() as env.
export { spawn, execFile } from "node:child_process";

const mediaVariables = new Set([
  "PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
  "LANG", "LANGUAGE", "HOME", "TMPDIR", "TMP", "TEMP",
  "LC_ALL", "LC_ADDRESS", "LC_COLLATE", "LC_CTYPE", "LC_IDENTIFICATION",
  "LC_MEASUREMENT", "LC_MESSAGES", "LC_MONETARY", "LC_NAME", "LC_NUMERIC",
  "LC_PAPER", "LC_TELEPHONE", "LC_TIME",
]);
const desktopVariables = new Set([
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS", "XDG_CACHE_HOME", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE",
  "DESKTOP_SESSION", "BROWSER",
]);

/** Construct a fresh environment; never subtract known secrets from the parent. */
export function childEnvironment(
  kind: "media" | "opener",
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const key = platform === "win32" ? name.toUpperCase() : name;
    if (value !== undefined && (mediaVariables.has(key)
      || (platform === "win32" && ["SYSTEMROOT", "WINDIR", "PATHEXT", "USERPROFILE"].includes(key))
      || (kind === "opener" && (desktopVariables.has(key) || (platform === "win32" && key === "COMSPEC"))))) {
      result[name] = value;
    }
  }
  return result;
}
