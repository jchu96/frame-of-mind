#!/usr/bin/env node
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import { analyzeMeeting } from "./services/analyze.js";
import { BluedotClient, DEFAULT_BLUEDOT_MCP_URL } from "./adapters/bluedot-mcp.js";
import { GranolaClient, DEFAULT_GRANOLA_MCP_URL } from "./adapters/granola-mcp.js";
import type { ContextProvider } from "./domain/types.js";
import { timestampToSeconds } from "./lib/time.js";
import { listBuiltInRecipes, loadRecipe } from "./recipes/index.js";

loadDotenv({ quiet: true });

const program = new Command()
  .name("frameofmind")
  .description("Video in. Understanding out. Run structured analysis recipes over meeting recordings.")
  .version("0.1.0");

program
  .command("auth")
  .description("Connect this machine to a meeting provider using browser OAuth.")
  .argument("<provider>", "bluedot or granola")
  .action(async (provider: string) => {
    const source = parseProvider(provider, false);
    const client = source === "bluedot" ? new BluedotClient() : new GranolaClient();
    await client.connect();
    await client.close();
    process.stdout.write(`${capitalize(source)} MCP authorization is ready.\n`);
  });

program
  .command("doctor")
  .description("Check local prerequisites without sending meeting data.")
  .action(async () => {
    const checks = [
      ["Node >=22", Number(process.versions.node.split(".")[0]) >= 22],
      ["GEMINI_API_KEY", Boolean(process.env.GEMINI_API_KEY)],
      ["GRANOLA_API_KEY (optional)", Boolean(process.env.GRANOLA_API_KEY)],
      ["ffmpeg (optional screenshots)", await executableExists("ffmpeg")],
    ] as const;
    for (const [name, ready] of checks) process.stdout.write(`${ready ? "ok" : "--"} ${name}\n`);
    process.stdout.write(`Bluedot MCP: ${process.env.BLUEDOT_MCP_URL || DEFAULT_BLUEDOT_MCP_URL}\n`);
    process.stdout.write(`Granola MCP: ${process.env.GRANOLA_MCP_URL || DEFAULT_GRANOLA_MCP_URL}\n`);
    process.stdout.write(`Artifact root: ${defaultOutputRoot()}\n`);
    if (!checks[0][1] || !checks[1][1]) process.exitCode = 1;
  });

program
  .command("recipes")
  .description("List built-in analysis recipes.")
  .action(() => {
    for (const recipe of listBuiltInRecipes()) {
      process.stdout.write(`${recipe.id.padEnd(14)} ${recipe.description}\n`);
    }
  });

program
  .command("analyze")
  .description("Analyze one meeting using Bluedot, Granola, or a local context file.")
  .argument("<meeting-id>", "Provider meeting/note ID or a stable local identifier")
  .requiredOption("--source <provider>", "Context provider: bluedot, granola, or file")
  .option("--granola-transport <transport>", "Granola context transport: mcp or api", "mcp")
  .option("--recipe <id>", "Built-in recipe", "issue-review")
  .option("--recipe-file <path>", "Custom JSON recipe; overrides --recipe")
  .option("--context-file <path>", "Transcript/meeting JSON, Markdown, text, SRT, or VTT for --source file")
  .option("--video <path>", "Use a recording already downloaded locally")
  .option("--recording-url <url>", "Use an expiring signed Bluedot media URL")
  .option("--transcript-offset <timestamp>", "Transcript time corresponding to video 00:00, for example 01:02:47")
  .option("--focus <instruction>", "Prioritize a specific repository, workflow, or UX concern")
  .option("-o, --output <directory>", "Artifact root", defaultOutputRoot())
  .option("--max-moments <count>", "Maximum candidate moments to interrogate", "10")
  .option("--no-screenshots", "Skip ffmpeg screenshots")
  .option("--keep-upload", "Leave the Gemini file until its provider expiration time")
  .action(async (meetingId: string, flags: {
    video?: string;
    recordingUrl?: string;
    source: string;
    granolaTransport: string;
    recipe: string;
    recipeFile?: string;
    contextFile?: string;
    transcriptOffset?: string;
    focus?: string;
    output: string;
    maxMoments: string;
    screenshots: boolean;
    keepUpload?: boolean;
  }) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Set GEMINI_API_KEY before analysis.");
    const recipeResult = await loadRecipe(flags.recipe, flags.recipeFile);
    const contextProvider = parseProvider(flags.source, true);
    const granolaTransport = parseGranolaTransport(flags.granolaTransport);
    if (contextProvider !== "granola" && granolaTransport !== "mcp") {
      throw new Error("--granola-transport is only valid with --source granola.");
    }
    if (flags.video && flags.recordingUrl) throw new Error("Use either --video or --recording-url, not both.");
    if (flags.recordingUrl && contextProvider !== "bluedot") {
      throw new Error("--recording-url is only valid with --source bluedot.");
    }
    if (contextProvider === "file" && !flags.contextFile) {
      throw new Error("--context-file is required with --source file.");
    }
    if (contextProvider !== "file" && flags.contextFile) {
      throw new Error("--context-file is only valid with --source file.");
    }
    if (!/^[1-9]\d*$/.test(flags.maxMoments)) throw new Error("--max-moments must be a positive integer.");
    const maxIncidents = Number(flags.maxMoments);
    if (!Number.isSafeInteger(maxIncidents) || maxIncidents > 1_000) {
      throw new Error("--max-moments must be between 1 and 1000.");
    }
    if (flags.video) await access(resolve(flags.video));
    const result = await analyzeMeeting({
      meetingId,
      recipe: recipeResult.recipe,
      customRecipe: recipeResult.custom,
      contextProvider,
      granolaTransport,
      ...(flags.contextFile ? { contextFile: flags.contextFile } : {}),
      apiKey,
      ...(flags.video ? { video: flags.video } : {}),
      ...(flags.recordingUrl ? { recordingUrl: flags.recordingUrl } : {}),
      ...(flags.focus ? { focus: flags.focus } : {}),
      outputRoot: flags.output,
      maxIncidents,
      screenshots: flags.screenshots,
      keepUpload: Boolean(flags.keepUpload),
      ...(flags.transcriptOffset
        ? { transcriptOffsetSeconds: parseTranscriptOffset(flags.transcriptOffset) }
        : {}),
    });
    const accepted = result.analysis.items.filter((item) => item.result.accepted).length;
    process.stdout.write(`Analysis: ${result.directory}\n${accepted} accepted record(s).\n`);
  });

program.showSuggestionAfterError();
program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`frameofmind: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function executableExists(command: string): Promise<boolean> {
  const paths = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  for (const path of paths) {
    try {
      await access(resolve(path, command));
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

function parseProvider(value: string, allowFile: boolean): ContextProvider {
  const providers = allowFile ? ["bluedot", "granola", "file"] : ["bluedot", "granola"];
  if (!providers.includes(value)) {
    throw new Error(`Unknown provider '${value}'. Expected ${providers.join(", ")}.`);
  }
  return value as ContextProvider;
}

function parseTranscriptOffset(value: string): number {
  if (!/^(?:\d{1,3}:)?\d{1,2}:\d{2}$/.test(value)) {
    throw new Error("--transcript-offset must be MM:SS or HH:MM:SS.");
  }
  return timestampToSeconds(value);
}

function parseGranolaTransport(value: string): "mcp" | "api" {
  if (value !== "mcp" && value !== "api") {
    throw new Error("--granola-transport must be mcp or api.");
  }
  return value;
}

function defaultOutputRoot(): string {
  if (process.env.FRAME_OF_MIND_OUTPUT) return resolve(process.env.FRAME_OF_MIND_OUTPUT);
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "frame-of-mind", "runs");
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "frame-of-mind", "runs");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "frame-of-mind", "runs");
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
