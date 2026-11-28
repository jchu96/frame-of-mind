import { hasCleanupReceipts } from "./adapters/twelvelabs-receipts.js";
import { checkDirectUpload, checkRoles, directUploadHint, disclosure, enginePlan, fallbackMessage, usesTwelveLabs } from "./domain/engine-plan.js";
import { rangeFields } from "./domain/range-fields.js";
import { rangeUsage } from "./domain/range-clock.js";
import { isRanged, withSourceRecording } from "./services/source-recording.js";
import { applicationSetting } from "./lib/application-settings.js";
import { KeyCommandRefused } from "./key-command.js";
import { cliSettings, keyNextStep } from "./cli-settings.js";
import { inspectScratch } from "./adapters/scratch.js";
import { mediaCapabilityReport, requireMedia } from "./services/media-capabilities.js";
import { capabilities, CliError, writeDocument } from "./cli-contract.js";
import { OptionError, UsageError, faultCode } from "./domain/contract-error.js";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { z } from "zod";
import {
  analyzeMeeting,
  MAX_DETAIL_CONCURRENCY,
  type AnalysisProgressEvent,
  type AnalyzeOptions,
  type AnalyzeResult,
} from "./services/analyze.js";
import { BluedotClient, DEFAULT_BLUEDOT_MCP_URL } from "./adapters/bluedot-mcp.js";
import { GranolaClient, DEFAULT_GRANOLA_MCP_URL } from "./adapters/granola-mcp.js";
import { ACCEPTED_RATES, declareClock } from "./domain/clock.js";
import { clockSummary } from "./services/artifacts.js";
import { calibrateClipClock } from "./adapters/gemini-calibration.js";
import { GeminiVideoAnalyzer } from "./adapters/gemini.js";
import { DEFAULT_GEMINI_MODEL } from "./adapters/gemini-model.js";
import { IS_RELEASE_BUNDLE, RELEASE_COMMIT, VERSION } from "./version.js";
import { registerKey } from "./commands/key.js";
import { loadRunNotes } from "./services/run-notes.js";
import { measuredTotal } from "./domain/token-usage.js";
import { resolveRetention } from "./domain/retention.js";
import { runLabelSchema } from "./domain/schemas.js";
import { THINKING_LEVELS, type ThinkingLevel, type ContextProvider } from "./domain/types.js";
import { parseTranscriptOffset } from "./lib/time.js";
import { redactUrlForDisplay } from "./lib/http.js";
import { telemetryCodeFromError } from "./lib/sentry-telemetry.js";
import {
  captureCliException,
  cliAnalysisTracer,
  flushCliTelemetry,
  isCliTelemetryEnabled,
} from "./telemetry.js";
import {
  analysisDepthSchema,
  listBuiltInRecipes,
  loadRecipe,
  withAnalysisDepth,
} from "./recipes/index.js";

import { defaultOutputRoot } from "./lib/paths.js";
import { registerSession } from "./commands/session.js";
import { registerMap } from "./commands/map.js";
import { registerSnap } from "./commands/snap.js";
import { snapSettings } from "./domain/snap.js";
import { registerMedia } from "./commands/media.js";
import { resolveTranscriptLanguage } from "./domain/transcript-language.js";
import { registerTranscribe, transcriptionHelp } from "./commands/transcribe.js";


export const program = new Command()
  .name("frameofmind")
  .description("Video in. Understanding out. Run structured analysis recipes over meeting recordings.")
  .version(VERSION);

program.command("mcp").description("Read a reviewed snapshot (bun --no-env-file <entry> mcp --database <absolute-file>)")
  .requiredOption("--database <absolute-file>", "reviewed SQLite snapshot")
  .action(() => { throw new Error("Start mcp directly with Bun and --no-env-file."); });

const geminiModelSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^gemini-[a-z0-9][a-z0-9.-]*$/, "expected a Gemini model ID");

export interface AnalyzeCliFlags {
  from?: string;
  to?: string;
  json?: boolean;
  snap?: string;
  snapGapMs?: string;
  snapWindowMs?: string;
  timelineOffset?: string;
  timecodeRate?: string;
  fileClock?: string;
  calibrate?: boolean;
  video?: string;
  recordingUrl?: string;
  source: string;
  granolaTransport: string;
  recipe: string;
  recipeFile?: string;
  contextFile?: string;
  transcriptOffset?: string;
  focus?: string;
  label?: string;
  note?: string[];
  depth: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  output: string;
  maxMoments: string;
  candidates?: string;
  proposer?: string;
  grader?: string;
  withholdGraderClaim?: boolean;
  indexWaitSeconds?: string;
  twelveLabsShape?: "flat" | "lines";
  dryRun?: boolean;
  screenshots: boolean;
  keepUpload?: boolean;
  deleteUpload?: boolean;
  retention?: string;
  remoteFile?: string;
  derivedTranscript: boolean;
  transcriptLanguage?: string;
  concurrency?: string;
}

program
  .command("auth")
  .description("Connect this machine to a meeting provider using browser OAuth.")
  .argument("<provider>", "bluedot or granola")
  .action(async (provider: string) => {
    const source = parseProvider(provider, false);
    const client = source === "bluedot" ? new BluedotClient(applicationSetting("BLUEDOT_MCP_URL")) : new GranolaClient(applicationSetting("GRANOLA_MCP_URL"));
    await client.connect();
    await client.close();
    process.stdout.write(`${capitalize(source)} MCP authorization is ready.\n`);
  });

program
  .command("doctor")
  .description("Check local prerequisites or inspect interrupted runs.")
  .option("--scratch [directory]", "list scratch in system temp or beside files in the given directory")
  .option("--remove <path>", "remove only this named, proven abandoned scratch entry")
  .option("--json", "print the versioned doctor report")
  .action(async (flags: {scratch?: string | boolean; remove?: string; json?: boolean}) => {
    if (flags.remove && !flags.scratch) throw new UsageError("remove-requires-scratch", "--remove requires --scratch.");
    const rows = flags.scratch || flags.json
      ? await inspectScratch(typeof flags.scratch === "string" ? flags.scratch : undefined, flags.remove)
      : [];
    if (flags.scratch && !flags.json) {
      for (const row of rows) {
        const action = flags.remove ? (row.removed ? "removed" : "skipped") : "listed";
        process.stdout.write(`${action} ${row.kind} ${JSON.stringify(row.path)} ${row.size ?? "?"} bytes, age ${row.ageMs ?? "?"} ms, ${row.state === "unproven" ? "" : "proven, "}${row.state}${row.reason ? ", " + row.reason : ""}\n`);
      }
      if (!rows.length) process.stdout.write("No matching scratch entries.\n");
      return;
    }
    const config = cliSettings();
    const key = config.keyReport();
    const twelve = config.keyReport("twelvelabs");
    const anyKey = key.present || twelve.present;
    const settingsPath = config.settingsPath();
    const preview = enginePlan({file:false,model:applicationSetting("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL,
          retention:resolveRetention({},applicationSetting("FRAME_OF_MIND_UPLOAD_RETENTION")),available:key.present,twelveAvailable:twelve.present,preview:true});
    const prerequisites = {
      node: Number(process.versions.node.split(".")[0]) >= 22,
      geminiKey: key.present,
      granolaKey: Boolean(applicationSetting("GRANOLA_API_KEY")),
    };
    const media = await mediaCapabilityReport();
    if (flags.json) {
      const leftovers = rows.map(({kind, path, size, ageMs, state, removed, reason}) =>
        ({kind, path, sizeBytes: size, ageMs, state, removed, reason: reason ?? null}));
      const checks = [
        { name: "node", required: true, ok: prerequisites.node, detail: process.versions.node },
        { name: "provider_key", required: true, ok: anyKey, detail: anyKey ? "configured" : "missing" },
        { name: "context_key", required: false, ok: prerequisites.granolaKey, detail: prerequisites.granolaKey ? "configured" : "missing" },
        ...Object.entries(media.tools).map(([name, tool]) => ({
          name, required: false, ok: tool.version !== null, detail: tool.version ?? tool.error!,
        })),
      ];
      writeDocument({
        ok: checks.every(check => !check.required || check.ok), checks, commands: media.commands.map(({ command: name, capabilities }) => ({ name, capabilities })), leftovers,
        roots: { mode: "none", file: null },
        enginePlan:preview, keys:{gemini:key,twelvelabs:twelve},
        key, settingsPath, artifactRoot: resolve(defaultOutputRoot()), toolVersion: VERSION,
        commit: RELEASE_COMMIT,
        cliSha256: IS_RELEASE_BUNDLE ? createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex") : null,
      });
      if (!anyKey && (key.commandDisabledByEnvironment || key.source === "unknown" || key.source === "command")) process.exitCode = 1;
      return;
    }
    if (!flags.scratch && (!prerequisites.node || !anyKey)) process.exitCode = 1;
    const checks = [
      ["Node >=22", prerequisites.node],
      [`GEMINI_API_KEY (${config.keyLabel()})`, prerequisites.geminiKey],
      [`TWELVELABS_API_KEY (${config.keyLabel("twelvelabs")})`, twelve.present],
      ["GRANOLA_API_KEY (optional)", prerequisites.granolaKey],
      ["ffmpeg (optional: screenshots, derived transcript, speech snapping)", media.tools.ffmpeg.version],
      ["ffprobe (optional: duration probe, media helpers)", media.tools.ffprobe.version],
    ] as const;
    for (const [name, ready] of checks) {
      process.stdout.write(`${ready ? "ok" : "--"} ${name}\n`);
      if (name.startsWith("GEMINI_API_KEY ")) {
        if (key.lowerSourcesSkipped) process.stdout.write("Lower-priority sources were skipped.\n");
        if (key.commandDisabledByEnvironment) process.stdout.write("Key command switched off by FRAME_OF_MIND_KEY_COMMAND.\n");
      }
    }
    if (twelve.commandDisabledByEnvironment) process.stdout.write("Key command switched off by FRAME_OF_MIND_TWELVELABS_KEY_COMMAND.\n");
    for (const line of disclosure(preview)) process.stdout.write(line+"\n");
    process.stdout.write(
      `Bluedot MCP: ${redactUrlForDisplay(applicationSetting("BLUEDOT_MCP_URL") || DEFAULT_BLUEDOT_MCP_URL)}\n`,
    );
    process.stdout.write(
      `Granola MCP: ${redactUrlForDisplay(applicationSetting("GRANOLA_MCP_URL") || DEFAULT_GRANOLA_MCP_URL)}\n`,
    );
    process.stdout.write(
      `Telemetry: ${isCliTelemetryEnabled() ? "on (Sentry)" : "off"}\n`,
    );
    if (IS_RELEASE_BUNDLE && isCliTelemetryEnabled()) {
      process.stdout.write("Automatic instrumentation of third-party modules is unavailable in the single-file build.\n");
    }
    process.stdout.write(`Artifact root: ${defaultOutputRoot()}\n`);
    for (const [name, tool] of Object.entries(media.tools)) process.stdout.write((tool.version ?? `${name} ${tool.error}`) + "\n");
    for (const {command, capabilities} of media.commands) {
      const absent = capabilities.filter(row => !row.present).map(row => row.name);
      const result = absent.length ? "Missing " + absent.join(", ") : "Ready";
      process.stdout.write(`${command} needs ${capabilities.map(row => row.name).join(", ")}. ${result}.\n`);
    }
    if (settingsPath) process.stdout.write("Settings file: " + JSON.stringify(settingsPath) + "\n");
    const next = !anyKey && keyNextStep(key, config.commandNextStep());
    if (next) process.stdout.write(next + "\n");
  });

program
  .command("recipes")
  .description("List built-in analysis recipes.")
  .option("--json", "print the versioned recipe list")
  .action((flags: { json?: boolean }) => {
    if (flags.json) {
      const recipes = listBuiltInRecipes().map(({ id, description }) => ({ id, description }));
      if (!recipes.length) throw new CliError("COMMAND_FAILED", "No built-in recipes available.");
      writeDocument({ recipes });
      return;
    }
    for (const recipe of listBuiltInRecipes()) {
      process.stdout.write(`${recipe.id.padEnd(14)} ${recipe.description}\n`);
    }
  });

program.command("capabilities").description("List commands, options and machine schema versions.")
  .option("--json", "print the versioned command inventory")
  .action((flags: { json?: boolean }) => {
    const inventory = capabilities(program);
    if (flags.json) writeDocument(inventory);
    else for (const row of inventory.commands) process.stdout.write([row.name, ...row.options].join(" ") + "\n");
  });

registerSession(program);
registerMedia(program);
registerSnap(program);
registerMap(program);
registerTranscribe(program);
registerKey(program);

program.command("calibrate")
  .description("Measure and cache the model's clip clock using a synthetic flash.")
  .option("--model <id>", "Gemini model ID")
  .option("--json", "Print the model clock measurement as JSON")
  .action(async (flags: { model?: string; json?: boolean }) => {
    const apiKey = await cliSettings().providerKey();
    if (!apiKey) throw new CliError("KEY_MISSING", "Set GEMINI_API_KEY before calibration.");
    if (flags.model !== undefined && !geminiModelSchema.safeParse(flags.model).success) throw new UsageError("invalid-model", "Invalid Gemini model ID.");
    await requireMedia("calibrate");
    const analyzer = new GeminiVideoAnalyzer(apiKey, flags.model ?? (applicationSetting("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL));
    const result = await calibrateClipClock(analyzer, { force: true, reportFailure: flags.json });
    const tokens = analyzer.takeUsage()?.totalTokens ?? null;
    if (flags.json) writeDocument(result);
    else process.stdout.write(`model clip clock: ${result.result}; tokens: ${tokens ?? "unknown"}\n`);
  });

program
  .command("analyze")
  .description("Analyze one video with optional Bluedot, Granola, or local context.")
  .addHelpText("after", transcriptionHelp)
  .argument("[meeting-id]", "Provider meeting/note ID; omit with --source none")
  .requiredOption("--source <provider>", "Context provider: bluedot, granola, file, or none")
  .option("--granola-transport <transport>", "Granola context transport: mcp or api", "mcp")
  .option("--recipe <id>", "Built-in recipe", "issue-review")
  .option("--recipe-file <path>", "Custom JSON recipe; overrides --recipe")
  .option("--context-file <path>", "Transcript/meeting JSON, Markdown, text, SRT, or VTT for --source file")
  .option("--video <path>", "Use a recording already downloaded locally")
  .option("--recording-url <url>", "Use an expiring signed Bluedot media URL")
  .option("--snap <method>", "Propose measured record edges with speech")
  .option("--snap-gap-ms <ms>", "Minimum observed pause (80–2000, default 250)")
  .option("--snap-window-ms <ms>", "Search radius (250–3000, default 1500)")
  .option("--from <time>", "inclusive source time or frame")
  .option("--to <time>", "exclusive source time or frame")
  .option("--timeline-offset <time>", "Sequence offset: seconds (up to 3 decimals), Nf whole frames, or HH:MM:SS:FF / HH:MM:SS;FF; video forms require --timecode-rate. Without a rate: exact milliseconds, seconds and ticks only; no frames or timecode")
  .option("--file-clock <clock>", "Input clock: source or reel", "source")
  .option("--timecode-rate <rate>", `Timeline timecode rendering: ${ACCEPTED_RATES}`)
  .option("--no-calibrate", "Skip clip-clock measurement and label the run unverified")
  .option("--transcript-offset <timestamp>", "Transcript time corresponding to video 00:00, for example 01:02:47")
  .option("--focus <instruction>", "Prioritize a specific repository, workflow, or UX concern")
  .option("--label <text>", "Human label for this run (e.g. the source title), shown in the manifest and reports; never sent to the model")
  .option("--depth <profile>", "Understanding depth: standard or deep", "standard")
  .option("--model <id>", `Gemini model ID, for example ${DEFAULT_GEMINI_MODEL} or gemini-pro-latest`)
  .addOption(new Option("--thinking-level <level>", "Gemini thinking level (default: provider setting)").choices(THINKING_LEVELS))
  .option("-o, --output <directory>", "Artifact root")
  .option("--proposer <engine>", "Engine that proposes candidate moments (gemini or twelvelabs)")
  .option("--grader <engine>", "Engine that grades candidate windows (gemini or twelvelabs)")
  .option("--withhold-grader-claim", "Grade each window without the proposal claim")
  .option("--index-wait-seconds <n>", "Maximum Twelve Labs queue wait in seconds")
  .addOption(new Option("--twelve-labs-shape <shape>", "Pegasus proposal structure").choices(["flat","lines"]))
  .option("--dry-run", "Preview the analysis route without a provider request")
  .option("--candidates <file>", "Grade a candidates document on the original recording clock")
  .option("--max-moments <n|all>", "First N eligible candidates in document order, or all eligible candidates", "10")
  .option("--note <name=path>", "Per-run UTF-8 text or Markdown reference (repeatable, up to 8)", (value: string, previous: string[]) => [...previous, value], [] as string[])
  .option("--concurrency <n>", "Parallel Gemini detail requests in pass 2 (default 1)")
  .option("--no-screenshots", "Skip ffmpeg screenshots")
  .option("--transcript-language <tag>", "Likely spoken language for derived transcription (BCP-47)")
  .option("--no-derived-transcript", "Skip deriving a transcript from the recording audio when no transcript is supplied")
  .option("--retention <mode>", "Upload retention: provider (default) or run; overrides FRAME_OF_MIND_UPLOAD_RETENTION")
  .option("--keep-upload", "Alias for --retention provider")
  .option("--delete-upload", "Alias for --retention run")
  .option("--json", "print the analysis outcome and absolute run directory as JSON")
  .option("--remote-file <name>", "Reuse a retained Gemini upload (files/...) of this exact recording; skips re-upload and never deletes it")
  .action(
    async (
      meetingId: string | undefined,
      flags: AnalyzeCliFlags,
    ) => {
      const startedAt = Date.now();
      let stage = "cli";
      const warnings: string[] = [];
      let failureFolder: string | undefined;
      let failedRun:import("./domain/run-failure.js").RunFailureManifest | undefined;
      let analyzeOptions: AnalyzeOptions | undefined;
      try {
        if (isRanged(flags) && flags.remoteFile) rangeUsage("A range cannot reuse a remote file.");
        checkRoles(flags, flags.candidates !== undefined);
        const config = cliSettings();
        const loaded = await readAnalyzeRecipe(flags);
        checkRoles(flags,flags.candidates !== undefined,loaded.recipe.engines);
        const proposer = flags.candidates ? "file" : flags.proposer ?? loaded.recipe.engines?.proposer;
        const grader = flags.grader ?? loaded.recipe.engines?.grader;
        const gemini = config.keyReport();
        if (!flags.dryRun && gemini.source === "command" && (grader === "gemini" || proposer === "gemini" || (!grader && gemini.present))) {
          await config.providerKey();
        }
        const twelve = config.keyReport("twelvelabs");
        if (!flags.dryRun && twelve.source === "command" && (proposer === "twelvelabs" || grader === "twelvelabs" || (!proposer && twelve.present))) {
          await config.providerKey("twelvelabs");
        }
        if (!flags.dryRun && !gemini.present && !twelve.present && !grader && !proposer) {
          if (gemini.source === "command") await config.providerKey();
          if (twelve.source === "command") await config.providerKey("twelvelabs");
          throw new CliError("KEY_MISSING","Set a provider key before analysis.",{engine:"gemini"});
        }
        for (const engine of [proposer,grader]) {
          if ((engine === "gemini" && !gemini.present) || (engine === "twelvelabs" && !twelve.present))
            throw new CliError("KEY_MISSING","Set the selected engine key before analysis.",{engine});
        }
        analyzeOptions = await buildAnalyzeOptions(meetingId, {...flags,dryRun:true}, undefined,loaded);
        const plan = enginePlan({...flags,file:flags.candidates !== undefined, recipe:analyzeOptions.recipe.engines,
          model:analyzeOptions.model ?? (applicationSetting("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL),
          retention:analyzeOptions.retention!,available:gemini.present,twelveAvailable:twelve.present,preview:true});
        if (flags.dryRun) {
          if (usesTwelveLabs(plan)) {
            const video = analyzeOptions.video;
            const bytes = !video ? undefined : isRanged(flags)
              ? await withSourceRecording(video, flags, "video", line => process.stderr.write(line + "\n"),
                async cut => (await stat(cut)).size)
              : (await stat(video)).size;
            checkDirectUpload(plan, bytes, process.argv.slice(2));
            if (plan.reason) process.stderr.write(fallbackMessage(plan.reason) + "\n");
            if (plan.reason === "media-limit") process.stderr.write(directUploadHint + "\n");
          }
          writeDocument({enginePlan:plan});
          return;
        }
        if (!plan.planned) {
          if (gemini.source === "command" && !gemini.present) await config.providerKey();
          throw new CliError("KEY_MISSING", "Set a provider key before analysis.", {engine:"gemini"});
        }
        for (const engine of ["gemini","twelvelabs"] as const) {
          if (plan.planned.proposer.engine !== engine && plan.planned.grader.engine !== engine) {
            if (engine !== "twelvelabs" || !twelve.present || !await hasCleanupReceipts()) continue;
          }
          const value = await config.providerKey(engine);
          if (!value) throw new CliError("KEY_MISSING","Set the selected engine key.",{engine});
          if (engine === "gemini") analyzeOptions.apiKey = value;
          else analyzeOptions.twelvelabsKey = value;
        }
        analyzeOptions.retryArgv = program.args[0] === "analyze" ? program.args : process.argv.slice(2);
        for (const line of disclosure(plan,analyzeOptions.recipe.twelveLabsSegments)) process.stderr.write(line+"\n");
        const cancellation = new AbortController();
        const cancel = () => cancellation.abort();
        // @types/bun 1.4.0 drops Node's signal overloads from process.on/off;
        // the runtime accepts signal names under both typings.
        process.on("SIGINT" as never, cancel);
        let result;
        try {
          const execution = {
            routeDisclosed:true, includeTokenUsage: true,
            signal: cancellation.signal,
            onFailurePublished(directory: string, manifest:NonNullable<typeof failedRun>) { failureFolder = directory; failedRun = manifest; },
            progress: {
              report(event: AnalysisProgressEvent) {
                stage = event.stage;
                if (flags.json && event.kind === "warning") warnings.push(event.message);
                CLI_ANALYSIS_PROGRESS.report(event);
              },
            },
          };
          const tracer = cliAnalysisTracer();
          if (tracer) {
            // Root metadata must agree with the provider spans: resolve the
            // model exactly as the analyzer does, and map operator-authored
            // custom recipe IDs to the closed "custom" bucket (ADR 0022 —
            // operator-authored strings never leave the process).
            const resolvedModel = plan.planned.grader.model!;
            const builtInRecipe = listBuiltInRecipes()
              .some((recipe) => recipe.id === analyzeOptions!.recipe.id);
            try {
              result = await tracer.span({
                op: "gen_ai.invoke_agent",
                name: "analyze run",
                attributes: {
                  "gen_ai.operation.name": "invoke_agent",
                  "gen_ai.provider.name": plan.planned.grader.engine === "gemini" ? "google_genai" : "twelvelabs",
                  "gen_ai.request.model": resolvedModel,
                  "frame_of_mind.recipe_id": builtInRecipe
                    ? analyzeOptions.recipe.id
                    : "custom",
                  "frame_of_mind.depth": String(flags.depth),
                  "frame_of_mind.max_moments": analyzeOptions.maxIncidents,
                  "frame_of_mind.context_mode": analyzeOptions.contextProvider ?? "none",
                },
              }, async (span) => {
                const analyzed = await analyzeMeeting(analyzeOptions!, { ...execution, tracer });
                span.setAttributes({
                  "frame_of_mind.outcome": analyzed.outcome.status,
                  "frame_of_mind.candidates_indexed": analyzed.outcome.candidates.indexed,
                  "frame_of_mind.candidates_omitted_by_limit":
                    analyzed.outcome.candidates.omittedByLimit,
                  "frame_of_mind.candidates_accepted": analyzed.outcome.candidates.accepted,
                  "frame_of_mind.candidates_failed": analyzed.outcome.candidates.failed,
                });
                return analyzed;
              });
            } finally {
              await flushCliTelemetry();
            }
          } else {
            result = await analyzeMeeting(analyzeOptions, execution);
          }
        } finally {
          process.off("SIGINT" as never, cancel);
        }
        printAnalysisSummary(result, flags.json ? process.stderr : process.stdout);
        if (flags.json) {
          const remote = result.manifest.remoteFile;
          const tokens = measuredTotal(result.manifest.tokenUsage);
          writeDocument({
            ...rangeFields.strip().parse(result.manifest),
            enginePlan:result.manifest.enginePlan, engineCalls:result.manifest.engineCalls, library:result.manifest.library,indexWait:result.manifest.indexWait,
            runFolder: resolve(result.directory),
            retention: analyzeOptions.retention,
            ...(tokens && { tokens }),
            runId: result.manifest.runId,
            outcome: result.outcome.status,
            acceptedCount: result.outcome.candidates.accepted,
            retainedUpload: remote?.name && !remote.deleted
              ? { name: remote.name, expiresAt: remote.expirationTime ?? null }
              : null,
            ...(warnings.length ? { warnings } : {}),
          });
        }
      } catch (error) {
        if (error instanceof KeyCommandRefused) throw error;
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
            version: VERSION,
          },
        );
        if (flags.json && failureFolder) {
          throw new CliError(faultCode(error), "Analysis failed.", {
            ...(error instanceof CliError && error.details), runFolder: resolve(failureFolder),
            ...(failedRun?.enginePlan && {enginePlan:failedRun.enginePlan,engineCalls:failedRun.engineCalls}),
            ...(failedRun?.library && {library:failedRun.library,indexWait:failedRun.indexWait}),
          });
        }
        if (!analyzeOptions && error instanceof OptionError) {
          throw error.asUsageError();
        }
        throw error;
      }
    },
  );

export function printAnalysisSummary(result: AnalyzeResult, stream: NodeJS.WritableStream = process.stdout): void {
  const { selected, indexed, omittedByLimit, outOfRange } = result.outcome.candidates;
  stream.write(
    `Interrogated ${selected} of ${indexed} indexed candidates` +
    (outOfRange ? `; ${outOfRange} out of range` : "") +
    (omittedByLimit ? ` (${omittedByLimit} ${result.manifest.enginePlan?.used?.proposer.source === "file" ? "lower-ranked" : "lower-importance"} dropped; --max-moments all to analyse every one).\n` : ".\n"),
  );
  stream.write(`${clockSummary(result.manifest.clock)}\n`);
  const accepted = result.analysis.items.filter((item) => item.result.accepted).length;
  stream.write(
    `Analysis: ${result.directory}${result.manifest.label ? ` (${result.manifest.label})` : ""}\n${accepted} accepted record(s). ` +
      `${result.outcome.candidates.validated}/${result.outcome.candidates.selected} selected candidate response(s) validated (${result.outcome.candidates.accepted} accepted, ${result.outcome.candidates.rejected} rejected, ${result.outcome.candidates.failed} failed); ${result.outcome.candidates.omittedByLimit} indexed candidate(s) omitted by limit; outcome=${result.outcome.status}.\n`,
  );
  if (result.snapSummary) {
    const { counts, total, medianShiftMs } = result.snapSummary;
    stream.write(`Speech edges: ${counts.snapped} snapped (${counts.noisy ?? 0} noisy), ${counts["no-boundary"]}/${total} no-boundary, ${counts.ambiguous} ambiguous, ${counts.unavailable} unavailable` +
      (medianShiftMs === undefined ? ".\n" : `, median signed shift ${medianShiftMs} ms (nearest rank).\n`));
  }
  const remoteFile = result.manifest.remoteFile;
  if (remoteFile && !remoteFile.deleted && remoteFile.name) {
    stream.write(
      `Retained Gemini upload: ${remoteFile.name}` +
        ` (${remoteFile.expirationTime ? `provider expiration ${remoteFile.expirationTime}` : "expiration not reported"}; per-file limit 2 GB). ` +
        (result.manifest.uploadedCutSha256 ? "\n" : `Reuse it for this same recording with --remote-file ${remoteFile.name}.\n`),
    );
  }
}

function parseQueueWait(text: string) {
  const n = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(n)) throw new UsageError("invalid-index-wait","Queue wait must be a positive integer.");
  return n;
}

async function readAnalyzeRecipe(flags:AnalyzeCliFlags) {
  return withAnalysisDepth(
    await loadRecipe(flags.recipe, flags.recipeFile).catch(error => {
      if (error instanceof Error && !("code" in error)) throw new UsageError("invalid-recipe-file", error.message);
      throw error;
    }),
    parseChoice(analysisDepthSchema, flags.depth, "invalid-depth"),
  );
}

export async function buildAnalyzeOptions(
  meetingId: string | undefined,
  flags: AnalyzeCliFlags,
  apiKey: string | undefined,
  loadedRecipe?: Awaited<ReturnType<typeof readAnalyzeRecipe>>,
): Promise<AnalyzeOptions> {
  if (flags.snap !== undefined && flags.snap !== "speech") throw new UsageError("invalid-snap", "--snap must be speech.");
  const integer = (text?: string) => text === undefined ? undefined : /^\d+$/.test(text) && text.trim() === text ? Number(text) : NaN;
  const settings = snapSettings(integer(flags.snapGapMs), integer(flags.snapWindowMs));
  const transcriptLanguage = resolveTranscriptLanguage(flags.transcriptLanguage, flags.derivedTranscript);
  if (!apiKey && !flags.dryRun) throw new CliError("KEY_MISSING", "Set GEMINI_API_KEY before analysis.", {engine:"gemini"});
  const retention = resolveRetention(flags, applicationSetting("FRAME_OF_MIND_UPLOAD_RETENTION"));
  const runNotes = await loadRunNotes(flags.note);
  const labelResult = flags.label === undefined ? undefined : runLabelSchema.safeParse(flags.label.trim());
  if (labelResult && !labelResult.success) {
    throw new UsageError("invalid-label", "--label must be one line of 1 to 200 characters without control characters.");
  }
  const label = labelResult?.data;
  const recipeResult = loadedRecipe ?? await readAnalyzeRecipe(flags);
  const modelResult = flags.model
    ? geminiModelSchema.safeParse(flags.model)
    : undefined;
  if (modelResult && !modelResult.success) {
    throw new UsageError("invalid-model",
      `--model must be a Gemini model ID such as ${DEFAULT_GEMINI_MODEL} or gemini-pro-latest.`,
    );
  }
  const model = modelResult?.data;
  const videoOnly = flags.source === "none";
  const contextProvider = videoOnly
    ? undefined
    : parseProvider(flags.source, true);
  if (!videoOnly && !meetingId) {
    throw new UsageError("missing-meeting-id", "A provider meeting/note ID is required unless --source none is selected.");
  }
  const granolaTransport = parseGranolaTransport(flags.granolaTransport);
  if (contextProvider !== "granola" && granolaTransport !== "mcp") {
    throw new UsageError("transport-source-mismatch", "--granola-transport is only valid with --source granola.");
  }
  if (flags.video && flags.recordingUrl) throw new UsageError("conflicting-video-inputs", "Use either --video or --recording-url, not both.");
  if (flags.recordingUrl && contextProvider !== "bluedot") {
    throw new UsageError("recording-url-source-mismatch", "--recording-url is only valid with --source bluedot.");
  }
  if (contextProvider === "file" && !flags.contextFile) {
    throw new UsageError("missing-context-file", "--context-file is required with --source file.");
  }
  if (contextProvider !== "file" && flags.contextFile) {
    throw new UsageError("context-file-requires-file-source", "--context-file is only valid with --source file.");
  }
  if (videoOnly && !flags.video) {
    throw new UsageError("missing-video", "--video is required with --source none.");
  }
  if (videoOnly && flags.transcriptOffset) {
    rangeUsage("--transcript-offset requires meeting or file context.");
  }
  if (flags.maxMoments !== "all" && !/^[1-9]\d*$/.test(flags.maxMoments)) throw new UsageError("invalid-max-moments", "--max-moments must be a positive integer.");
  const maxIncidents = flags.maxMoments === "all" ? 1_000 : Number(flags.maxMoments);
  if (!Number.isSafeInteger(maxIncidents) || maxIncidents > 1_000) {
    throw new UsageError("invalid-max-moments", "--max-moments must be between 1 and 1000.");
  }
  const detailConcurrency = parseDetailConcurrency(
    flags.concurrency,
    applicationSetting("FRAME_OF_MIND_DETAIL_CONCURRENCY"),
  );
  if (flags.remoteFile && isRanged(flags)) rangeUsage("A range cannot reuse a remote file.");
  if (flags.remoteFile) {
    if (!flags.video) {
      throw new UsageError("remote-file-requires-video", "--remote-file requires --video so the local recording can be verified and screenshotted.");
    }
    if (!/^files\/[A-Za-z0-9_-]+$/.test(flags.remoteFile)) {
      throw new UsageError("invalid-remote-file", "--remote-file must be a Gemini file name such as files/abc123.");
    }
  }
  if (flags.video) await access(resolve(flags.video));
  if (flags.timelineOffset !== undefined || !/^from-media:(df|ndf)$/.test(flags.timecodeRate ?? "")) declareClock(flags.timelineOffset, flags.timecodeRate);
  const fileClock = parseChoice(z.enum(["source", "reel"]), flags.fileClock ?? "source", "invalid-file-clock");
  const common = {
    ...(flags.from !== undefined && {from:flags.from}), ...(flags.to !== undefined && {to:flags.to}),
    ...(flags.snap ? { snapSettings: settings } : {}),
    ...(flags.timelineOffset !== undefined ? { timelineOffset: flags.timelineOffset } : {}),
    ...(flags.timecodeRate !== undefined ? { timecodeRate: flags.timecodeRate } : {}),
    fileClock,
    calibrate: flags.calibrate !== false,
    recipe: recipeResult.recipe,
    customRecipe: recipeResult.custom,
    recipeSha256: recipeResult.sha256,
    recipeRevision: recipeResult.revision,
    apiKey: apiKey ?? "",
    ...(flags.withholdGraderClaim && {withholdGraderClaim:true}),
    ...(flags.indexWaitSeconds !== undefined && {indexWaitSeconds:parseQueueWait(flags.indexWaitSeconds)}),
    ...(flags.twelveLabsShape && {twelveLabsShape:flags.twelveLabsShape}),
    ...(model ? { model } : {}),
    ...(flags.thinkingLevel && { thinkingLevel: flags.thinkingLevel }),
    ...(flags.focus ? { focus: flags.focus } : {}),
    ...(label ? { label } : {}),
    ...(runNotes.length ? { runNotes } : {}),
    indexFps: recipeResult.indexFps,
    outputRoot: flags.output ?? defaultOutputRoot(),
    maxIncidents,
    ...(flags.proposer !== undefined && {proposer:flags.proposer}),
    ...(flags.grader !== undefined && {grader:flags.grader}),
    ...(flags.candidates !== undefined && {candidatesFile: flags.candidates}),
    detailConcurrency,
    screenshots: flags.screenshots,
    keepUpload: retention === "provider",
    retention,
    ...(flags.remoteFile ? { remoteFileName: flags.remoteFile } : {}),
    derivedTranscript: flags.derivedTranscript !== false,
    ...(transcriptLanguage && { transcriptLanguage }),
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
        ...(flags.json && { interactiveProviderAuth: false }),
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
function parseChoice<T>(schema: z.ZodType<T>, value: string, reason: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UsageError(reason, parsed.error.message);
  return parsed.data;
}

function parseProvider(value: string, allowFile: boolean): ContextProvider {
  const providers = allowFile ? ["bluedot", "granola", "file"] : ["bluedot", "granola"];
  if (!providers.includes(value)) {
    throw new OptionError("invalid-source", `Unknown provider '${value}'. Expected ${providers.join(", ")}.`);
  }
  return value as ContextProvider;
}

function parseDetailConcurrency(flag: string | undefined, environment: string | undefined): number {
  const [label, value] = flag !== undefined
    ? ["--concurrency", flag]
    : ["FRAME_OF_MIND_DETAIL_CONCURRENCY", environment || "1"];
  if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_DETAIL_CONCURRENCY) {
    throw new UsageError("invalid-concurrency", `${label} must be an integer from 1 to ${MAX_DETAIL_CONCURRENCY}.`);
  }
  return Number(value);
}

function parseGranolaTransport(value: string): "mcp" | "api" {
  if (value !== "mcp" && value !== "api") {
    throw new UsageError("invalid-context-transport", "--granola-transport must be mcp or api.");
  }
  return value;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
