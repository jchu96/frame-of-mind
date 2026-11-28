import { userInfo } from "node:os";
import { realpathSync } from "node:fs";
import { failureDocument, faultExits } from "./domain/contract-error.js";

export type LaunchMode = "clean" | "bare";
export interface CliLaunch {
  readonly mode: LaunchMode;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly cwd: string;
  readonly accountHome?: string;
}

export function classifyLaunch(isBun: boolean, flags: readonly string[]): LaunchMode {
  if (isBun) return flags.includes("--no-env-file") ? "clean" : "bare";
  // Node accepts env-file options only on its command line.
  return flags.some(flag => /^--env-file(?:-if-exists)?(?:=|$)/.test(flag)) ? "bare" : "clean";
}

export function inheritedValue(environment: Readonly<NodeJS.ProcessEnv>, name: string, platform = process.platform) {
  if (platform !== "win32" || Object.hasOwn(environment, name)) return environment[name];
  const original = Object.keys(environment).find(key => key.toUpperCase() === name);
  return original === undefined ? undefined : environment[original];
}

export function captureLaunch(): CliLaunch {
  const mode = classifyLaunch(!!process.versions.bun, process.execArgv);
  const environment: NodeJS.ProcessEnv = Object.create(null);
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  let accountHome: string | undefined;
  if (mode === "clean" && process.platform !== "win32") {
    try { accountHome = userInfo().homedir; } catch { /* A command lookup will refuse. */ }
  }
  return Object.freeze({mode, accountHome, environment: Object.freeze(environment), cwd: realpathSync(".")});
}

export function refuseBareJobStart(args: string[]) {
  const end = args.indexOf("--");
  if (args.slice(0, end < 0 ? args.length : end).includes("--json")) {
    process.stdout.write(JSON.stringify(failureDocument("USAGE")) + "\n");
  } else {
    process.stderr.write("Credential source unknown. Start with a clean launcher.\n");
  }
  process.exitCode = faultExits.USAGE;
}
