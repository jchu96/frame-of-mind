export const E2E_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CI",
  "LANG",
  "LC_ALL",
  "TZ",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;

export function createE2EEnvironment(
  source: NodeJS.ProcessEnv,
  additions: Record<string, string> = {},
): Record<string, string> {
  const environment = { ...additions };
  for (const name of E2E_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}
