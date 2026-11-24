import { Command, CommanderError } from "commander";
import { VERSION } from "./version.js";

const CLI_SCHEMA_VERSION = 1;
const failures = {
  COMMAND_FAILED: [1, "Command failed."],
  DECODE_FAILED: [1, "Media decoding failed."],
  VERIFY_MISMATCH: [1, "Verification failed."],
  USAGE: [2, "Invalid command arguments. See the command help."],
  KEY_REFUSED: [10, "An accepted API key is required."],
  PERMISSION_DENIED: [11, "Access denied."],
  PATH_OUTSIDE_ROOTS: [11, "Path outside the allowed roots."],
  NOT_FOUND: [20, "Resource not found."],
  UPLOAD_EXPIRED: [20, "Upload expired."],
  CONFLICT: [30, "Resource already exists or changed."],
  UNKNOWN_SCHEMA: [2, "Unsupported schema version."],
  INVALID_INPUT: [2, "Invalid time value."],
  INVALID_RATE: [2, "Invalid frame rate."],
  INVALID_TIMECODE: [2, "Invalid timecode."],
  NOT_ON_FRAME_BOUNDARY: [2, "Time is between frames."],
  UNREPRESENTABLE: [2, "Time cannot be represented at this rate."],
} as const;
type Code = keyof typeof failures;

export class CliError extends Error {
  constructor(readonly code: Code, message: string) { super(message); }
}

export function writeDocument(fields: object, write = (line: string) => { process.stdout.write(line + "\n"); }) {
  write(JSON.stringify({ schemaVersion: CLI_SCHEMA_VERSION, ...fields }));
}

const systemCodes: Readonly<Record<string, Code>> = {
  ENOENT: "NOT_FOUND", EPERM: "PERMISSION_DENIED", EACCES: "PERMISSION_DENIED", EEXIST: "CONFLICT",
};

function failureCode(error: unknown): Code {
  if (error instanceof CommanderError) return "USAGE";
  const original = (error as { code?: unknown } | null)?.code;
  if (typeof original === "string") {
    if (Object.hasOwn(failures, original)) return original as Code;
    if (Object.hasOwn(systemCodes, original)) return systemCodes[original]!;
  }
  return "COMMAND_FAILED";
}

export function writeFailure(error: unknown, write = (line: string) => { process.stderr.write(line + "\n"); }) {
  const code = failureCode(error);
  // Parser, filesystem and provider errors can echo private input.
  const message = error instanceof CliError ? error.message : failures[code][1];
  writeDocument({ code, message }, write);
  process.exitCode = failures[code][0];
}

function commandTree(root: Command): Command[] {
  return [root, ...root.commands.flatMap(commandTree)];
}

function schemaVersions(root: Command) {
  const names = root.commands.filter(command => command.options.some(option => option.long === "--json")).map(command => command.name());
  return Object.fromEntries(["version", ...names].map(name => [name, CLI_SCHEMA_VERSION]));
}

export function capabilities(root: Command) {
  const commands = commandTree(root).map(command => {
    const words = [];
    for (let part: Command | null = command; part?.parent; part = part.parent) words.unshift(part.name());
    return { name: words.join(" ") || root.name(), options: command.createHelp().visibleOptions(command).map(option => option.flags) };
  });
  return { commands, schemaVersions: schemaVersions(root) };
}

export async function runCli(root: Command, args: string[]) {
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  const machine = options.includes("--json");
  for (const command of commandTree(root)) {
    command.exitOverride();
    if (machine) command.configureOutput({ writeOut() {}, writeErr() {} });
  }
  try {
    if (machine) root.hook("preAction", (_root, command) => {
      const flags = command.opts();
      if (flags.json !== true) throw new CliError("USAGE", "This invocation does not select machine output.");
      const values = [...command.args, ...Object.values(flags)];
      if (values.some(value => typeof value === "string" && value.split(/[\\/]/).includes(".."))) {
        throw new CliError("PATH_OUTSIDE_ROOTS", "Use a path without parent traversal.");
      }
    });
    if (machine && options.some(arg => ["--version", "-V"].includes(arg))) {
      if (args.length !== 2) throw new CliError("USAGE", "Use --version --json.");
      writeDocument({ version: VERSION, schemaVersions: schemaVersions(root) });
      return;
    }
    if (machine && options.some(arg => arg === "--help" || arg === "-h" || (arg === "help" && args[0] === arg))) {
      throw new CliError("USAGE", "Use capabilities --json for machine-readable help.");
    }
    await root.parseAsync(args, { from: "user" });
  } catch (error) {
    if (machine) writeFailure(error);
    else if (error instanceof CommanderError) process.exitCode = error.code === "commander.unknownOption" ? 2 : error.exitCode;
    else {
      process.stderr.write(`frameofmind: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
