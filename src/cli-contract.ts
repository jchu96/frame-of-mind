import { Command, CommanderError } from "commander";
import { VERSION } from "./version.js";

import { CLI_SCHEMA_VERSION, ContractError, failureDocument, faultCode, faultExits } from "./domain/contract-error.js";
export { ContractError as CliError } from "./domain/contract-error.js";

function stdoutLine(line: string) { process.stdout.write(line + "\n"); }

export function writeDocument(fields: object, write = stdoutLine) {
  write(JSON.stringify({ schemaVersion: CLI_SCHEMA_VERSION, ...fields }));
}

export function writeFailure(error: unknown, write = stdoutLine) {
  const code = error instanceof CommanderError ? "USAGE" : faultCode(error);
  write(JSON.stringify(failureDocument(code, error instanceof ContractError ? error.details : undefined)));
  process.exitCode = faultExits[code];
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
  return { commands, schemaVersions: Object.fromEntries(commands.map(({ name }) => [name, [CLI_SCHEMA_VERSION]])) };
}

function selectSchema(args: string[]) {
  const rest = [];
  let selected = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return [...rest, ...args.slice(i)];
    if (arg !== "--schema-version" && !arg.startsWith("--schema-version=")) { rest.push(arg); continue; }
    const major = arg === "--schema-version" ? args[++i] : arg.slice("--schema-version=".length);
    if (selected || !major || !/^[1-9]\d*$/.test(major)) throw new ContractError("USAGE", "Expected one schema major.");
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
      if (flags.force) throw new ContractError("USAGE", "Machine calls require fresh outputs.");
      if (flags.json !== true) throw new ContractError("USAGE", "This invocation does not select machine output.");
      const values = [...command.args, ...Object.values(flags)];
      if (values.some(value => typeof value === "string" && value.split(/[\\/]/).includes(".."))) {
        throw new ContractError("PATH_OUTSIDE_ROOTS", "Use a path without parent traversal.");
      }
    });
    if (machine && options.some(arg => ["--version", "-V"].includes(arg))) {
      if (args.length !== 2) throw new ContractError("USAGE", "Use --version --json.");
      writeDocument({ version: VERSION, schemaVersions: capabilities(root).schemaVersions });
      return;
    }
    if (machine && options.some(arg => arg === "--help" || arg === "-h" || (arg === "help" && args[0] === arg))) {
      throw new ContractError("USAGE", "Use capabilities --json for machine-readable help.");
    }
    await root.parseAsync(args, { from: "user" });
  } catch (error) {
    if (machine) writeFailure(error);
    else if (error instanceof CommanderError) process.exitCode = error.exitCode;
    else {
      process.stderr.write(`frameofmind: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
