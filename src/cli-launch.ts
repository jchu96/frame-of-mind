import { realpathSync } from "node:fs";
import { failureDocument, faultExits } from "./domain/contract-error.js";

export type LaunchMode = "clean" | "bare" | "refused";
export interface CliLaunch {
  readonly mode: LaunchMode;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly cwd: string;
}

// NODE_OPTIONS accepts double-quoted arguments and backslash escapes inside quotes.
function optionWords(input: string): string[] {
  const words: string[] = [];
  let word = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '"') quoted = !quoted;
    else if (quoted && c === "\\" && i + 1 < input.length) word += input[++i];
    else if (!quoted && c === " ") { if (word) words.push(word); word = ""; }
    else word += c;
  }
  if (word) words.push(word);
  return words;
}

export function classifyLaunch(isBun: boolean, flags: string[], nodeOptions = ""): LaunchMode {
  if (isBun) return flags.includes("--no-env-file") ? "clean" : "bare";
  return [...flags, ...optionWords(nodeOptions)].some(arg => {
    const option = arg.split("=", 1)[0]!.replaceAll("_", "-");
    return /^--(?:env-file(?:-if-exists)?|import|require|(?:experimental-)?loader)$/.test(option)
      || /^-r/.test(arg);
  }) ? "refused" : "clean";
}

export function inheritedValue(environment: Readonly<NodeJS.ProcessEnv>, name: string, platform = process.platform) {
  if (platform !== "win32" || Object.hasOwn(environment, name)) return environment[name];
  const original = Object.keys(environment).find(key => key.toUpperCase() === name);
  return original === undefined ? undefined : environment[original];
}

export function captureLaunch(): CliLaunch {
  const mode = classifyLaunch(!!process.versions.bun, process.execArgv, process.env.NODE_OPTIONS);
  const environment: NodeJS.ProcessEnv = Object.create(null);
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return Object.freeze({mode, environment: Object.freeze(environment), cwd: realpathSync(".")});
}

export function refuseLaunch(args: string[]) {
  const end = args.indexOf("--");
  if (args.slice(0, end < 0 ? args.length : end).includes("--json")) {
    process.stdout.write(JSON.stringify(failureDocument("USAGE")) + "\n");
  } else {
    process.stderr.write("Credential source unknown. Start with a clean launcher.\n");
  }
  process.exitCode = faultExits.USAGE;
}
