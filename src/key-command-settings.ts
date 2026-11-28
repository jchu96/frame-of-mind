import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { inheritedValue, readAccountHome, type CliLaunch } from "./cli-launch.js";

export type CommandSetting =
  | {kind: "absent"}
  | {kind: "unavailable"; fix: string}
  | {kind: "command"; argv: [string, ...string[]]; home: string};

const selector = "FRAME_OF_MIND_KEY_COMMAND";

export function userSettingsPath(home: string | undefined, platform: NodeJS.Platform) {
  if (!home || !isAbsolute(home)) return;
  if (platform === "darwin") return join(home, "Library", "Application Support", "frameofmind", "settings.json");
  if (platform === "linux") return join(home, ".config", "frameofmind", "settings.json");
}

function unavailable(fix: string): CommandSetting { return {kind: "unavailable", fix}; }
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function quoted(path: string) { return "'" + path.replaceAll("'", "'\\''").replace(/[\r\n]/g, "?") + "'"; }

function fileSetting(home: string, path: string, uid: number): unknown {
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
    if (Object.keys(data).length === 0) return;
    if (Object.keys(data).length !== 1 || !Object.hasOwn(data, "keyCommand")) throw new Error();
    // The only accepted value is an array of strings. After removing JSON
    // strings, a second colon can only belong to another member.
    const structure = raw.replace(/"(?:[^"\\]|\\.)*"/g, "");
    if (structure.indexOf(":") !== structure.lastIndexOf(":")) throw new Error();
    return data.keyCommand;
  } finally { closeSync(fd); }
}

export function commandSetting(launch: CliLaunch, platform: NodeJS.Platform): CommandSetting {
  const override = inheritedValue(launch.environment, selector, platform);
  if (launch.mode === "bare") {
    const blocked = unavailable("Run the installed Node command.");
    if (override !== undefined) return blocked;
    if (platform !== "darwin" && platform !== "linux") return {kind: "absent"};
    // A merged home lookup is diagnostic only. Never resolve a reader from it.
    const home = launch.accountHome ?? readAccountHome();
    const path = userSettingsPath(home, platform);
    if (!home || !path) return blocked;
    try {
      return fileSetting(home, path, process.geteuid!()) === undefined ? {kind: "absent"} : blocked;
    } catch { return blocked; }
  }
  const home = launch.accountHome;
  const path = userSettingsPath(home, platform);
  if (platform !== "darwin" && platform !== "linux") {
    return override === undefined ? {kind: "absent"} : unavailable("Remove " + selector + " and configure GEMINI_API_KEY.");
  }
  if (!home || !path) return unavailable("Restore access to your account home directory.");
  const repair = override === undefined ? "Check the keyCommand setting in " + quoted(path) + "." : "Correct " + selector + ".";
  try {
    const uid = process.geteuid!();
    const argv = override === undefined ? fileSetting(home, path, uid) : JSON.parse(override);
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
