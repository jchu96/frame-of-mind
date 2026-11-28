import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { inheritedValue, readAccountHome, type CliLaunch } from "./cli-launch.js";

export type CommandSetting =
  | {kind: "absent"}
  | {kind: "none"}
  | {kind: "unavailable"; fix: string}
  | {kind: "command"; argv: [string, ...string[]]; home: string};

export type KeyEngine = "gemini" | "twelvelabs";
export const keyVariables = {gemini:"GEMINI_API_KEY", twelvelabs:"TWELVELABS_API_KEY"} as const;
export const selectors = {gemini:"FRAME_OF_MIND_KEY_COMMAND", twelvelabs:"FRAME_OF_MIND_TWELVELABS_KEY_COMMAND"} as const;

export function userSettingsPath(home: string | undefined, platform: NodeJS.Platform) {
  if (!home || !isAbsolute(home)) return;
  if (platform === "darwin") return join(home, "Library", "Application Support", "frameofmind", "settings.json");
  if (platform === "linux") return join(home, ".config", "frameofmind", "settings.json");
}

function unavailable(fix: string): CommandSetting { return {kind: "unavailable", fix}; }
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function quoted(path: string) { return "'" + path.replaceAll("'", "'\\''").replace(/[\r\n]/g, "?") + "'"; }

function fileSetting(home: string, path: string, uid: number, engine: KeyEngine): unknown {
  const tool = dirname(path);
  let parent = home;
  for (const component of relative(home, tool).split(sep)) {
    parent = join(parent, component);
    let stat;
    try { stat = lstatSync(parent); }
    catch (error) { if (missing(error)) return; throw error; }
    if (!stat.isDirectory() || (stat.uid !== uid && (parent === tool || stat.uid !== 0))) {
      throw unavailable("Use an owned directory at " + quoted(parent) + ".");
    }
    if (parent === tool ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0) {
      throw unavailable("Run chmod " + (parent === tool ? "700 " : "go-w ") + quoted(parent) + ".");
    }
  }
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid) throw unavailable("Use a regular file you own at " + quoted(path) + ".");
    if ((stat.mode & 0o7777) !== 0o600) throw unavailable("Run chmod 600 " + quoted(path) + ".");
    const raw = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(readFileSync(fd));
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    const keys = Object.keys(data);
    if (keys.length === 0) return;
    if (keys.length !== 1) throw new Error();
    // Count object members outside strings so JSON.parse cannot silently pick
    // the last spelling of a duplicated key (including an escaped spelling).
    const members = raw.replace(/"(?:[^"\\]|\\.)*"/g, "").split(":").length - 1;
    if (keys[0] === "keyCommand" && members === 1)
      return engine === "gemini" ? data.keyCommand : undefined;
    const map = data.keyCommands;
    if (keys[0] !== "keyCommands" || !map || typeof map !== "object" || Array.isArray(map)) throw new Error();
    const engines = Object.keys(map);
    if (members !== engines.length + 1 || engines.some(name => !Object.hasOwn(selectors,name))) throw new Error();
    return map[engine];
  } finally { closeSync(fd); }
}

export function launchCommandOverride(launch: CliLaunch, platform: NodeJS.Platform, engine: KeyEngine = "gemini") {
  const selector = selectors[engine];
  const raw = inheritedValue(launch.environment, selector, platform);
  if (raw === undefined) return {kind: "absent"} as const;
  let argv: unknown;
  try { argv = JSON.parse(raw); }
  catch { argv = null; } // Invalid input uses the launcher's usual refusal and repair.
  if (Array.isArray(argv) && argv.length === 0) return {kind: "none"} as const;
  return {kind: "override", argv} as const;
}

export function commandSetting(launch: CliLaunch, platform: NodeJS.Platform, override = launchCommandOverride(launch, platform), engine: KeyEngine = "gemini"): CommandSetting {
  const selector = selectors[engine];
  if (override.kind === "none") return override;
  if (launch.mode === "bare") {
    const blocked = unavailable("Run the installed Node command.");
    if (override.kind === "override") return blocked;
    if (platform !== "darwin" && platform !== "linux") return {kind: "absent"};
    // A merged home lookup is diagnostic only. Never resolve a reader from it.
    const home = launch.accountHome ?? readAccountHome();
    const path = userSettingsPath(home, platform);
    if (!home || !path) return blocked;
    try {
      return fileSetting(home, path, process.geteuid!(), engine) === undefined ? {kind: "absent"} : blocked;
    } catch { return blocked; }
  }
  const home = launch.accountHome;
  const path = userSettingsPath(home, platform);
  if (platform !== "darwin" && platform !== "linux") {
    return override.kind === "absent" ? {kind: "absent"} : unavailable("Remove " + selector + " and configure " + keyVariables[engine] + ".");
  }
  if (!home || !path) return unavailable("Restore access to your account home directory.");
  const repair = override.kind === "absent" ? "Check the keyCommand setting in " + quoted(path) + "." : "Correct " + selector + ".";
  try {
    const uid = process.geteuid!();
    const argv = override.kind === "absent" ? fileSetting(home, path, uid, engine) : override.argv;
    if (argv === undefined) return {kind: "absent"};
    if (!Array.isArray(argv) || !argv.length || !argv.every(arg => typeof arg === "string" && !arg.includes("\0")) || !isAbsolute(argv[0])) {
      return unavailable(repair);
    }
    const executable = realpathSync(argv[0]);
    const stat = statSync(executable);
    if (!stat.isFile() || (stat.uid !== uid && stat.uid !== 0)) return unavailable(repair);
    if (stat.mode & 0o022) return unavailable("Run chmod go-w " + quoted(executable) + ".");
    if (!(stat.mode & 0o111)) return unavailable("Make " + quoted(executable) + " executable.");
    accessSync(executable, constants.X_OK);
    return {kind: "command", argv: [executable, ...argv.slice(1)], home};
  } catch (error) {
    if (error && typeof error === "object" && "kind" in error && error.kind === "unavailable") return error as CommandSetting;
    return unavailable(repair);
  }
}
