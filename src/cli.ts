#!/usr/bin/env node
import { captureLaunch, inheritedValue, refuseBareJobStart } from "./cli-launch.js";
import { jobInvocation } from "./job-invocation.js";
import { useChildEnvironment } from "./lib/child-env.js";
import type * as Cli from "./cli-main.js";

export type { AnalyzeCliFlags } from "./cli-main.js";
const launch = captureLaunch();
export const CLI_LIBRARY_IMPORT = Symbol.for("frameofmind.cli.libraryImport");
export let program: typeof Cli.program;
export let buildAnalyzeOptions: typeof Cli.buildAnalyzeOptions;
export let printAnalysisSummary: typeof Cli.printAnalysisSummary;

const libraryImport = (globalThis as Record<symbol, unknown>)[CLI_LIBRARY_IMPORT] === true;
const args = process.argv.slice(2);
if (!libraryImport && launch.mode === "clean") useChildEnvironment(launch.environment);
const job = !libraryImport && jobInvocation(args);
if (launch.mode === "bare" && job && job.op === "start") {
  refuseBareJobStart(args);
} else if (job) {
  const { runJobCommand } = await import("./commands/jobs.js");
  await runJobCommand(job.family, job.op, process.argv.slice(4), {readKey: () => inheritedValue(launch.environment, "GEMINI_API_KEY")});
} else if (process.argv[2] === "mcp" && !libraryImport) {
  const args = process.argv.slice(3);
  if (args.slice(0, args.includes("--") ? args.indexOf("--") : args.length).includes("--json")) {
    const { writeFailure, CliError } = await import("./cli-contract.js");
    writeFailure(new CliError("USAGE", "MCP uses a protocol session."));
  } else if (!process.versions.bun) {
    process.stderr.write("BUN_REQUIRED: use bun --no-env-file <entry> mcp --database <absolute-file> with BUN_RUNTIME_TRANSPILER_CACHE_PATH=0\n");
    process.exitCode = 20;
  } else {
    try {
      const { runMcp } = await import("./commands/mcp.js");
      await runMcp(process.argv.slice(3));
    } catch {
      process.stderr.write("INVALID_PROJECTION\n");
      process.exitCode = 1;
    }
  }
} else {
  if (!libraryImport) {
    const { configureOrdinaryCli } = await import("./cli-settings.js");
    configureOrdinaryCli(launch);
  }
  ({ program, buildAnalyzeOptions, printAnalysisSummary } = await import("./cli-main.js"));
  // Loading this module runs the command. Guessing the entry point from argv[1]
  // failed silently through symlinks and launchers (bugs.md, 2026-11-13 and
  // 2026-11-22), so the only way not to run is an explicit library import.
  if (!libraryImport) {
    const { runCli } = await import("./cli-contract.js");
    await runCli(program, process.argv.slice(2));
  }
}
