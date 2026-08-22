#!/usr/bin/env node
import "./instrument.js";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import {
  analyzeMeeting,
  type AnalysisProgressEvent,
  type AnalyzeOptions,
} from "./services/analyze.js";
import { BluedotClient, DEFAULT_BLUEDOT_MCP_URL } from "./adapters/bluedot-mcp.js";
import { GranolaClient, DEFAULT_GRANOLA_MCP_URL } from "./adapters/granola-mcp.js";
import { DEFAULT_GEMINI_MODEL } from "./adapters/gemini-model.js";
import type { ContextProvider } from "./domain/types.js";
import { parseTranscriptOffset } from "./lib/time.js";
import { redactUrlForDisplay } from "./lib/http.js";
import { telemetryCodeFromError } from "./lib/sentry-telemetry.js";
import {
  captureCliException,
  isCliTelemetryEnabled,
} from "./telemetry.js";
import {
  analysisDepthSchema,
  listBuiltInRecipes,
  loadRecipe,
  withAnalysisDepth,
} from "./recipes/index.js";

loadDotenv({ quiet: true });

const program = new Command()
  .name("frameofmind")
  .description("Video in. Understanding out. Run structured analysis recipes over meeting recordings.")
  .version("0.3.0");

const geminiModelSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^gemini-[a-z0-9][a-z0-9.-]*$/, "expected a Gemini model ID");

export interface AnalyzeCliFlags {
  video?: string;
  recordingUrl?: string;
  source: string;
  granolaTransport: string;
  recipe: string;
  recipeFile?: string;
  contextFile?: string;
  transcriptOffset?: string;
  focus?: string;
  depth: string;
  model?: string;
  output: string;
  maxMoments: string;
  screenshots: boolean;
  keepUpload?: boolean;
  remoteFile?: string;
  derivedTranscript: boolean;
}

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
      ["ffmpeg (optional: screenshots, derived transcript)", await executableExists("ffmpeg")],
    ] as const;
    for (const [name, ready] of checks) process.stdout.write(`${ready ? "ok" : "--"} ${name}\n`);
    process.stdout.write(
      `Bluedot MCP: ${redactUrlForDisplay(process.env.BLUEDOT_MCP_URL || DEFAULT_BLUEDOT_MCP_URL)}\n`,
    );
    process.stdout.write(
      `Granola MCP: ${redactUrlForDisplay(process.env.GRANOLA_MCP_URL || DEFAULT_GRANOLA_MCP_URL)}\n`,
    );
    process.stdout.write(
      `Telemetry: ${isCliTelemetryEnabled() ? "on (Sentry)" : "off"}\n`,
    );
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
  .description("Analyze one video with optional Bluedot, Granola, or local context.")
  .argument("[meeting-id]", "Provider meeting/note ID; omit with --source none")
  .requiredOption("--source <provider>", "Context provider: bluedot, granola, file, or none")
  .option("--granola-transport <transport>", "Granola context transport: mcp or api", "mcp")
  .option("--recipe <id>", "Built-in recipe", "issue-review")
  .option("--recipe-file <path>", "Custom JSON recipe; overrides --recipe")
  .option("--context-file <path>", "Transcript/meeting JSON, Markdown, text, SRT, or VTT for --source file")
  .option("--video <path>", "Use a recording already downloaded locally")
  .option("--recording-url <url>", "Use an expiring signed Bluedot media URL")
  .option("--transcript-offset <timestamp>", "Transcript time corresponding to video 00:00, for example 01:02:47")
  .option("--focus <instruction>", "Prioritize a specific repository, workflow, or UX concern")
  .option("--depth <profile>", "Understanding depth: standard or deep", "standard")
  .option("--model <id>", `Gemini model ID, for example ${DEFAULT_GEMINI_MODEL} or gemini-pro-latest`)
  .option("-o, --output <directory>", "Artifact root", defaultOutputRoot())
  .option("--max-moments <count>", "Maximum candidate moments to interrogate", "10")
  .option("--no-screenshots", "Skip ffmpeg screenshots")
  .option("--no-derived-transcript", "Skip deriving a transcript from the recording audio when no transcript is supplied")
  .option("--keep-upload", "Leave the Gemini file until its provider expiration time")
  .option("--remote-file <name>", "Reuse a retained Gemini upload (files/...) of this exact recording; skips re-upload and never deletes it")
  .action(
    async (
      meetingId: string | undefined,
      flags: AnalyzeCliFlags,
    ) => {
      const startedAt = Date.now();
      let stage = "cli";
      let analyzeOptions: AnalyzeOptions | undefined;
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("Set GEMINI_API_KEY before analysis.");
        analyzeOptions = await buildAnalyzeOptions(meetingId, flags, apiKey);
        const cancellation = new AbortController();
        const cancel = () => cancellation.abort();
        process.on("SIGINT", cancel);
        let result;
        try {
          result = await analyzeMeeting(
            analyzeOptions,
            {
              signal: cancellation.signal,
              progress: {
                report(event) {
                  stage = event.stage;
                  CLI_ANALYSIS_PROGRESS.report(event);
                },
              },
            },
          );
        } finally {
          process.off("SIGINT", cancel);
        }
        const accepted = result.analysis.items.filter((item) => item.result.accepted).length;
        process.stdout.write(
          `Analysis: ${result.directory}\n${accepted} accepted record(s). ` +
            `${result.outcome.candidates.validated}/${result.outcome.candidates.selected} selected candidate response(s) validated (${result.outcome.candidates.accepted} accepted, ${result.outcome.candidates.rejected} rejected, ${result.outcome.candidates.failed} failed); ${result.outcome.candidates.omittedByLimit} indexed candidate(s) omitted by limit; outcome=${result.outcome.status}.\n`,
        );
        const remoteFile = result.manifest.remoteFile;
        const retentionRequested = Boolean(flags.keepUpload || flags.remoteFile);
        if (retentionRequested && remoteFile && !remoteFile.deleted && remoteFile.name) {
          process.stdout.write(
            `Retained Gemini upload: ${remoteFile.name}` +
              `${remoteFile.expirationTime ? ` (provider expiration ${remoteFile.expirationTime})` : ""}. ` +
              `Reuse it for this same recording with --remote-file ${remoteFile.name}.\n`,
          );
        }
      } catch (error) {
        await captureCliException(
          telemetryCodeFromError(error, "analysis_failed"),
          {
            stage,
            recipeId: analyzeOptions?.recipe.id ?? flags.recipe,
            ...(analyzeOptions?.recipeRevision
              ? { recipeRevision: analyzeOptions.recipeRevision }
              : {}),
            ...(analyzeOptions?.model ?? flags.model
              ? { model: analyzeOptions?.model ?? flags.model }
              : {}),
            durationMs: Math.max(0, Date.now() - startedAt),
            studioMode: "cli",
            version: "0.3.0",
          },
        );
        throw error;
      }
    },
  );

export async function buildAnalyzeOptions(
  meetingId: string | undefined,
  flags: AnalyzeCliFlags,
  apiKey: string,
): Promise<AnalyzeOptions> {
  const recipeResult = await withAnalysisDepth(
    await loadRecipe(flags.recipe, flags.recipeFile),
    analysisDepthSchema.parse(flags.depth),
  );
  const modelResult = flags.model
    ? geminiModelSchema.safeParse(flags.model)
    : undefined;
  if (modelResult && !modelResult.success) {
    throw new Error(
      `--model must be a Gemini model ID such as ${DEFAULT_GEMINI_MODEL} or gemini-pro-latest.`,
    );
  }
  const model = modelResult?.data;
  const videoOnly = flags.source === "none";
  const contextProvider = videoOnly
    ? undefined
    : parseProvider(flags.source, true);
  if (!videoOnly && !meetingId) {
    throw new Error("A provider meeting/note ID is required unless --source none is selected.");
  }
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
  if (videoOnly && !flags.video) {
    throw new Error("--video is required with --source none.");
  }
  if (videoOnly && flags.transcriptOffset) {
    throw new Error("--transcript-offset requires meeting or file context.");
  }
  if (!/^[1-9]\d*$/.test(flags.maxMoments)) throw new Error("--max-moments must be a positive integer.");
  const maxIncidents = Number(flags.maxMoments);
  if (!Number.isSafeInteger(maxIncidents) || maxIncidents > 1_000) {
    throw new Error("--max-moments must be between 1 and 1000.");
  }
  if (flags.remoteFile) {
    if (!flags.video) {
      throw new Error("--remote-file requires --video so the local recording can be verified and screenshotted.");
    }
    if (!/^files\/[A-Za-z0-9_-]+$/.test(flags.remoteFile)) {
      throw new Error("--remote-file must be a Gemini file name such as files/abc123.");
    }
  }
  if (flags.video) await access(resolve(flags.video));
  const common = {
    recipe: recipeResult.recipe,
    customRecipe: recipeResult.custom,
    recipeSha256: recipeResult.sha256,
    recipeRevision: recipeResult.revision,
    apiKey,
    ...(model ? { model } : {}),
    ...(flags.focus ? { focus: flags.focus } : {}),
    indexFps: recipeResult.indexFps,
    outputRoot: flags.output,
    maxIncidents,
    screenshots: flags.screenshots,
    keepUpload: Boolean(flags.keepUpload),
    ...(flags.remoteFile ? { remoteFileName: flags.remoteFile } : {}),
    derivedTranscript: flags.derivedTranscript !== false,
  };
  return videoOnly
    ? {
        ...common,
        contextMode: "none",
        video: flags.video!,
      }
    : {
        ...common,
        meetingId: meetingId!,
        contextProvider: contextProvider!,
        granolaTransport,
        ...(flags.contextFile ? { contextFile: flags.contextFile } : {}),
        ...(flags.video ? { video: flags.video } : {}),
        ...(flags.recordingUrl ? { recordingUrl: flags.recordingUrl } : {}),
        ...(flags.transcriptOffset
          ? { transcriptOffsetSeconds: parseTranscriptOffset(flags.transcriptOffset) }
          : {}),
      };
}

const CLI_ANALYSIS_PROGRESS = {
  report(event: AnalysisProgressEvent) {
    if (event.kind === "warning") {
      process.stderr.write(`Warning: ${event.message}\n`);
      return;
    }
    const showMessage =
      (event.kind === "stage" &&
        ["fetching_context", "uploading_to_gemini", "indexing", "interrogating"].includes(event.stage)) ||
      (event.kind === "progress" && ["fetching_context", "interrogating"].includes(event.stage));
    if (showMessage && event.message) {
      process.stderr.write(`${event.message}\n`);
    }
  },
} satisfies { report(event: AnalysisProgressEvent): void };

program.showSuggestionAfterError();
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  program.parseAsync().catch((error: unknown) => {
    process.stderr.write(`frameofmind: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function executableExists(command: string): Promise<boolean> {
  const isWindows = process.platform === "win32";
  const candidates = isWindows
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
  const paths = (process.env.PATH || "").split(isWindows ? ";" : ":");
  for (const path of paths) {
    if (!path) continue;
    for (const candidate of candidates) {
      try {
        await access(resolve(path, candidate));
        return true;
      } catch {
        // Try the next candidate or PATH entry.
      }
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
