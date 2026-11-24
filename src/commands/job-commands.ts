import { Command } from "commander";
import { ContractError } from "../domain/contract-error.js";
import type { Family } from "../adapters/job-record.js";
import type { JobOperation } from "../services/cli-job.js";

const operations = ["start", "status", "result", "cancel", "dry-run"] as const;
export function jobInvocation(args: string[]) {
  const [family, operation] = args;
  if ((family !== "analyze" && family !== "transcribe") || !operations.includes(operation as JobOperation)) return;
  if (operation === "dry-run" && family !== "analyze") return;
  // Without job flags, preserve a human recording or meeting literally named
  // "start", "status", etc. Source-backed human analyzes can also request JSON.
  const hasGrant = args.some(arg => /^--(?:out|request-id|media-root|output-root|roots-file)(?:=|$)/.test(arg));
  if (!hasGrant && !args[2]?.match(/^[^-]/)) return;
  return {family, op: operation as JobOperation} as const;
}
function append(value: string, previous: string[] = []) { return [...previous, value]; }
export function jobCommand(family: Family, op: JobOperation) {
  const send = op === "start" || op === "dry-run";
  const cmd = new Command(op).allowExcessArguments(false).argument(send ? "<file>" : "<job-id>")
    .requiredOption("--json", "print a versioned machine response")
    .requiredOption("--out <directory>", "job output directory")
    .option("--media-root <directory>", "granted source directory", append)
    .option("--output-root <directory>", "granted destination directory", append)
    .option("--roots-file <file>", "operator-owned roots document");
  if (send) {
    cmd.requiredOption("--max-media-seconds <seconds>").requiredOption("--max-provider-requests <count>")
      .requiredOption("--max-file-bytes <bytes>").requiredOption("--allowed-models <ids>")
      .requiredOption("--retention <policy>").option("--model <id>");
    if (family === "analyze") cmd.requiredOption("--recipe <id>").option("--snap <method>");
    else cmd.option("--transcript-json", "also write the transcript JSON export");
    if (op === "start") cmd.requiredOption("--request-id <uuid>").option("--after-unknown <job-id>");
  }
  return cmd;
}
export function jobInventory() {
  return (["analyze", "transcribe"] as const).flatMap(family => operations
    .filter(op => family === "analyze" || op !== "dry-run")
    .map(op => ({name: family + " " + op, options: [...jobCommand(family, op).options.map(flag => flag.long!), "--schema-version"]})));
}
export function rejectDuplicateJobOptions(args: string[]) {
  const seen = new Set<string>();
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("--")) continue;
    const flag = arg.split("=")[0]!;
    if (seen.has(flag) && flag !== "--media-root" && flag !== "--output-root") {
      throw new ContractError("USAGE", "Duplicate job option.");
    }
    seen.add(flag);
  }
}
