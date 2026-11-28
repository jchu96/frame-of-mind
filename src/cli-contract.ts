import { maxRangeSeconds } from "./lib/range-policy.js";
import { KeyCommandRefused } from "./key-command.js";
import { Command, CommanderError } from "commander";
import { jobInventory } from "./commands/job-commands.js";
import { VERSION } from "./version.js";

import { CLI_SCHEMA_VERSION, ContractError, FrameGridError, MissingJobArgumentError, UsageError, failureDocument, faultCode, faultExits } from "./domain/contract-error.js";
export { ContractError as CliError, UsageError } from "./domain/contract-error.js";

function stdoutLine(line: string) { process.stdout.write(line + "\n"); }

export function writeDocument(fields: object, write = stdoutLine) {
  write(JSON.stringify({ schemaVersion: CLI_SCHEMA_VERSION, ...fields }));
}

const parserReasons: Record<string, string> = {
  "commander.unknownCommand": "unknown-command",
  "commander.unknownOption": "unknown-option",
  "commander.missingArgument": "missing-argument",
  "commander.optionMissingArgument": "missing-option-value",
  "commander.missingMandatoryOptionValue": "missing-required-option",
  "commander.excessArguments": "excess-arguments",
  "commander.invalidArgument": "invalid-argument",
  "commander.help": "missing-command",
};

function parserUsage(error: CommanderError) {
  return new UsageError(parserReasons[error.code] ?? "invalid-argument", error.message);
}

export function writeFailure(caught: unknown, write = stdoutLine) {
  const error = caught instanceof CommanderError ? parserUsage(caught) : caught;
  const code = faultCode(error);
  const document = failureDocument(code, error instanceof ContractError ? error.details : undefined);
  if (error instanceof MissingJobArgumentError || error instanceof FrameGridError) document.error.message = error.message;
  write(JSON.stringify(document));
  process.exitCode = faultExits[code];
}

export function humanFailureExit(error: unknown) {
  return faultCode(error) === "USAGE" ? faultExits.USAGE : 1;
}

function commandTree(root: Command): Command[] {
  return [root, ...root.commands.flatMap(commandTree)];
}

export function capabilities(root: Command) {
  const commands = [{ name: "version", options: ["--json", "--schema-version"] }];
  for (const command of root.commands.filter(cmd => cmd.options.some(option => option.long === "--json"))) {
    const options = command.options.filter(option => option.long !== "--force")
      .flatMap(option => [option.short, option.long].filter((flag): flag is string => Boolean(flag)));
    commands.push({ name: command.name(), options: [...options, "--schema-version"] });
  }
  commands.push(...jobInventory());
  return { commands, maxRangeSeconds: maxRangeSeconds(), schemaVersions: Object.fromEntries(commands.map(({ name }) => [name, [CLI_SCHEMA_VERSION]])) };
}

function selectSchema(args: string[]) {
  const rest = [];
  let selected = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return [...rest, ...args.slice(i)];
    if (arg !== "--schema-version" && !arg.startsWith("--schema-version=")) { rest.push(arg); continue; }
    const major = arg === "--schema-version" ? args[++i] : arg.slice("--schema-version=".length);
    if (selected) throw new UsageError("duplicate-schema-version", "Expected one schema major.");
    if (!major || !/^[1-9]\d*$/.test(major)) throw new UsageError("invalid-schema-version", "Expected one schema major.");
    if (major !== String(CLI_SCHEMA_VERSION)) throw new ContractError("UNKNOWN_SCHEMA", "Unsupported schema major.");
    selected = true;
  }
  return rest;
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
    if (machine) args = selectSchema(args);
    if (machine) root.hook("preAction", (_root, command) => {
      const flags = command.opts();
      if (flags.force) throw new UsageError("force-with-json", "Machine calls require fresh outputs.");
      if (flags.json !== true) throw new UsageError("json-output-not-selected", "This invocation does not select machine output.");
      const values = [...command.args, ...Object.values(flags)];
      if (values.some(value => typeof value === "string" && value.split(/[\\/]/).includes(".."))) {
        throw new ContractError("PATH_OUTSIDE_ROOTS", "Use a path without parent traversal.");
      }
    });
    if (machine && options.some(arg => ["--version", "-V"].includes(arg))) {
      if (args.length !== 2) throw new UsageError("version-arguments", "Use --version --json.");
      writeDocument({ version: VERSION, schemaVersions: capabilities(root).schemaVersions });
      return;
    }
    if (machine && options.some(arg => arg === "--help" || arg === "-h" || (arg === "help" && args[0] === arg))) {
      throw new UsageError("help-with-json", "Use capabilities --json for machine-readable help.");
    }
    await root.parseAsync(args, { from: "user" });
  } catch (caught) {
    if (caught instanceof CommanderError && caught.exitCode === 0) return;
    const error = caught instanceof CommanderError ? parserUsage(caught) : caught;
    if (machine) {
      if (error instanceof ContractError && error.code === "USAGE" && error.details?.reason === error.message) process.stderr.write(error.message + "\n");
      writeFailure(error);
    }
    else if (error instanceof KeyCommandRefused) {
      process.stderr.write(error.message + "\n");
      process.exitCode = faultExits.KEY_REFUSED;
    } else {
      // Commander already wrote the human diagnostic.
      if (!(caught instanceof CommanderError)) process.stderr.write(`frameofmind: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = humanFailureExit(error);
    }
  }
}
