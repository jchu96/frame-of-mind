import { TwelveLabs, twelveTransport } from "../adapters/twelvelabs.js";
import { receiptDirectory, ScratchReceipts } from "../adapters/twelvelabs-receipts.js";
import type { EngineCall } from "../domain/engine-receipts.js";
import { defaultDualRoute, engineReason, fallbackPlan, geminiRetry, PEGASUS_MODEL, DIRECT_UPLOAD_BYTES, soundOnlyHint, checkDirectUpload, checkRoles, directUploadHint, disclosure, enginePlan, fallbackMessage, usesTwelveLabs, type EngineItems } from "../domain/engine-plan.js";
import { mediaRequestStarted, preparationDetails, uploadMedia, withMediaTransfer } from "../lib/media-transfer.js";
import { recordingIdentity, readCandidates, type Candidate, type CandidatesDocument } from "../domain/candidates.js";
import { loadCandidatesFile } from "../adapters/candidates-file.js";
import { measurementSearch, measurementWindow, proposalEdges, resolveEdges } from "../domain/proposal-edges.js";
import { latestPosition, proposalWindow } from "./proposal-windows.js";
import { rangeTranscript } from "./range-context.js";
import { rangeUsage, type RangeRequest } from "../domain/range-clock.js";
import { type Bound, boundIndex, boundMillis, humanTime, modelBound, modelSpan, sourceBound } from "../domain/source-bound.js";
import { preparationError, SourceReceipt } from "../domain/source-receipt.js";
import { isRanged, withSourceRecording, maxRangeSeconds as resolveMaxVideoSeconds } from "./source-recording.js";
import { applicationSetting } from "../lib/application-settings.js";
import { ContractError, faultCode } from "../domain/contract-error.js";
import { createScratch } from "../adapters/scratch.js";
import { VERSION } from "../version.js";
import { classify, proposeRecords, snapSettings, summarizeSnaps, type SnapRun, type SnapSettings } from "../domain/snap.js";
import { declareClock, runClockSchema, type ClockDeclaration, type ClipClock, type RunClock } from "../domain/clock.js";
import { probeFrameRate } from "./media-probe.js";
import { calibrateClipClock, type Calibration } from "../adapters/gemini-calibration.js";
import { readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { geminiEnginePorts } from "../adapters/gemini-candidates.js";
import { resolveTranscriptLanguage } from "../domain/transcript-language.js";
import type { RunNote } from "../domain/run-notes.js";
import type { TokenUsage } from "../domain/token-usage.js";
import type { UploadRetention } from "../domain/retention.js";
import type { File as GeminiFile } from "@google/genai";
import { z } from "zod";
import type {
  AnalysisDetail,
  AnalysisRecipe,
  DetailStill,
  ThinkingLevel,
  AnalysisRun,
  AnalysisRunV3,
  AnalysisRunV4, AnalysisRunV5,
  AnalysisItem,
  ContextProvider,
  DerivedTranscriptProvenance,
  DerivedTranscriptionSegment,
  IndexedMoment,
  MeetingContextSource,
  MeetingEvidence,
  MediaSource,
  RunManifest,
  RunManifestV3,
  VersionedAnalysisRun,
  VersionedRunManifest,
} from "../domain/types.js";
import {
  analysisDigest,
  sha256Utf8,
  validateVersionedRunImport,
} from "../domain/integrity.js";
import {
  type VersionedRunImport,
} from "../domain/schemas.js";
import { BluedotClient } from "../adapters/bluedot-mcp.js";
import { GranolaClient } from "../adapters/granola-mcp.js";
import { GranolaApiClient } from "../adapters/granola-api.js";
import { FileContextSource } from "../adapters/file-context.js";
import { DEFAULT_GEMINI_MODEL, GeminiVideoAnalyzer, promptPrefix } from "../adapters/gemini.js";
import {
  NOOP_ANALYSIS_TRACER,
  type AnalysisTracer,
  type TraceAttributes,
} from "../lib/telemetry-trace.js";
import { GeminiFileError } from "../adapters/gemini-files.js";
import {
  createRunId,
  downloadFile,
  ensureDirectory,
  MAX_RECORDING_BYTES,
  mimeForPath,
  safePathSegment,
  sha256File,
  sha256Text,
} from "../lib/files.js";
import {
  formatDerivedTranscript,
  windowOnGrid,
  mergeTranscriptionChunks,
  nearbyTranscript,
  transcriptOffsetVerified,
  windowTranscript,
  offsetTranscriptionSegments,
} from "./transcript.js";
import {
  decodeSpeechEnvelope,
  extractAudioTrack,
  planTranscriptionWindows,
  probeDurationSeconds,
} from "./audio.js";
import { markQuietLines, measureTrack } from "./transcript-coverage.js";
import { TRANSCRIPTION_WINDOW_SECONDS, TRANSCRIPTION_OVERLAP_SECONDS } from "./transcription-policy.js";
import { extractScreenshot } from "./screenshots.js";
import { buildContactSheet, CONTACT_SHEET_MAX_TILES } from "./contact-sheet.js";
import { buildTimes, renderClockTime, writeArtifacts, writeFailureManifest } from "./artifacts.js";
import { extractDetailStills, unavailableStillWarning, unreadScreenTextWarning } from "./detail-stills.js";
import { clipWindow, secondsToTimestamp, timestampToSeconds } from "../lib/time.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import {
  analysisOutcomeSchema,
  CandidateAnalysisError,
  type AnalysisOutcome,
  type CandidateFailure,
} from "../domain/analysis-outcome.js";
import {
  runFailureManifestSchema,
  type AnalysisFailurePhase,
  type RunFailureManifest,
} from "../domain/run-failure.js";

// When this many leading candidates all fail at generation with nothing
// validated, the run aborts as systematic instead of burning a provider call
// per remaining candidate.
const GENERATION_FAILURE_CIRCUIT_BREAKER = 3;

// One failed window discards the whole transcript, so a window that exhausts
// the adapter's per-request retries is re-uploaded and transcribed once more
// after a pause long enough to outlast a load-shedding episode.
const TRANSCRIPTION_WINDOW_ATTEMPTS = 2;
const TRANSCRIPTION_WINDOW_RETRY_MS = 20_000;

interface AnalyzeOptionsBase extends RangeRequest {
  twelvelabsKey?: string;
  retryArgv?: string[];
  withholdGraderClaim?: boolean;
  indexWaitSeconds?: number;
  twelveLabsShape?: "flat" | "lines";
  candidatesFile?: string;
  proposer?: string;
  grader?: string;
  snapSettings?: SnapSettings;
  timelineOffset?: string;
  timecodeRate?: string;
  fileClock?: "source" | "reel";
  calibrate?: boolean;
  recipe: AnalysisRecipe;
  customRecipe: boolean;
  recipeSha256: string;
  recipeRevision: string;
  apiKey: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  video?: string;
  videoMimeType?: string;
  expectedVideoSha256?: string;
  recordingUrl?: string;
  focus?: string;
  /** Operator-supplied human label recorded in the manifest and reports. */
  label?: string;
  runNotes?: RunNote[];
  indexFps?: number;
  outputRoot: string;
  maxIncidents: number;
  screenshots: boolean;
  keepUpload: boolean;
  /** Resolved CLI policy; legacy library/Studio callers retain their explicit boolean. */
  retention?: UploadRetention;
  /**
   * Reuse an operator-retained Gemini Files API upload (`files/...`) for this
   * exact recording instead of uploading again. The run never deletes a file
   * it did not create.
   */
  remoteFileName?: string;
  derivedTranscript?: boolean;
  transcriptLanguage?: string;
  /**
   * Maximum overlapping pass-2 detail requests (1-8, default 1). Results are
   * still committed in candidate order.
   */
  detailConcurrency?: number;
}

export type ContextEnrichedAnalyzeOptions = AnalyzeOptionsBase & {
  contextMode?: "meeting";
  meetingId: string;
  contextProvider: ContextProvider;
  granolaTransport: "mcp" | "api";
  granolaApiKey?: string;
  interactiveProviderAuth?: boolean;
  contextFile?: string;
  transcriptOffsetSeconds?: number;
};

export type VideoOnlyAnalyzeOptions = AnalyzeOptionsBase & {
  contextMode: "none";
  video: string;
  meetingId?: never;
  contextProvider?: never;
  granolaTransport?: never;
  granolaApiKey?: never;
  interactiveProviderAuth?: never;
  contextFile?: never;
  recordingUrl?: never;
  transcriptOffsetSeconds?: never;
};

export type AnalyzeOptions =
  | ContextEnrichedAnalyzeOptions
  | VideoOnlyAnalyzeOptions;

export const ANALYSIS_PROGRESS_STAGES = [
  "fetching_context",
  "uploading_to_gemini",
  "indexing",
  "interrogating",
  "rendering",
  "cleaning_up",
] as const;

export type AnalysisProgressStage = (typeof ANALYSIS_PROGRESS_STAGES)[number];

export type AnalysisProgressEvent =
  | {
      kind: "stage";
      stage: AnalysisProgressStage;
      message: string;
    }
  | {
      kind: "progress";
      stage: AnalysisProgressStage;
      progress: {
        completed: number;
        total: number;
        unit: "bytes" | "items" | "steps";
      };
      message?: string;
    }
  | {
      kind: "warning";
      stage: AnalysisProgressStage;
      message: string;
    };

export interface AnalysisProgressReporter {
  report(event: AnalysisProgressEvent): Promise<void> | void;
}

export type AnalysisProjectionInput = VersionedRunImport;

export type PublishedAnalysisRun = AnalysisProjectionInput & {
  readonly directory: string;
  readonly outcome: AnalysisOutcome;
};

export interface AnalysisProjectionPublisher {
  publish(run: AnalysisProjectionInput): Promise<void>;
}

export interface AnalyzeExecutionOptions {
  routeDisclosed?: boolean;
  /** Include the per-pass usage receipt in CLI manifests. */
  includeTokenUsage?: boolean;
  /** The job caller supplies a fresh private directory inside its output grant. */
  jobScratchRoot?: string;
  /** Called after the failure manifest has been atomically published. */
  onFailurePublished?: (directory: string, manifest:RunFailureManifest) => void;
  signal?: AbortSignal;
  progress?: AnalysisProgressReporter;
  projection?: AnalysisProjectionPublisher;
  /**
   * Content-free tracing port (ADR 0022). Optional and inert by default;
   * the CLI injects a Sentry-backed tracer only when the operator opted in.
   */
  tracer?: AnalysisTracer;
}

interface MeetingAnalysisIndex {
  isRelevantCall: boolean;
  matchNotes: string;
  transcriptAlignment: {
    offsetSeconds: number;
    confidence: "high" | "medium" | "low" | "none";
    rationale: string;
  };
  moments: IndexedMoment[];
}

interface VideoOnlyAnalysisIndex {
  matchNotes: string;
  moments: IndexedMoment[];
}

type AnalysisIndex = MeetingAnalysisIndex | VideoOnlyAnalysisIndex;

export interface AnalysisVideoAnalyzer {
  indexProposals?: AnalysisVideoAnalyzer["index"];
  probeClipClock?(file: GeminiFile): Promise<number>;
  readonly relativeEvidenceResponses?: number;
  readonly model: string;
  readonly thinkingLevel?: ThinkingLevel;
  upload(path: string, mimeType: string): Promise<GeminiFile>;
  resolveRetainedFile?(
    name: string,
    expectedSha256Hex: string,
    expectedSizeBytes: number,
  ): Promise<GeminiFile>;
  index(
    file: GeminiFile,
    meeting: MeetingEvidence | undefined,
    recipe: AnalysisRecipe,
    focus?: string,
    indexFps?: number,
    derivedTranscript?: string,
    runNotes?: readonly RunNote[],
    ranged?: boolean,
  ): Promise<AnalysisIndex>;
  interrogate(
    file: GeminiFile,
    candidate: Pick<IndexedMoment, "start" | "end" | "summary" | "surface"> & {withheld?:boolean},
    nearbyTranscript: string | undefined,
    recipe: AnalysisRecipe,
    focus?: string,
    transcriptDerived?: boolean,
    runNotes?: readonly RunNote[],
    modelClipClock?: ClipClock,
    stills?: readonly DetailStill[],
    rangeSeconds?: number,
  ): Promise<AnalysisDetail>;
  transcribe?(file: GeminiFile, requestedLanguage?: string, durationSeconds?: number, ranged?: boolean): Promise<DerivedTranscriptionSegment[]>;
  delete(file: GeminiFile): Promise<void>;
  measuredUsageByPass?(): TokenUsage | undefined;
  /**
   * Non-destructive cumulative token counts since construction. Distinct
   * from the spend path's draining `takeUsage`; used only to attribute
   * per-span token deltas when tracing is active.
   */
  usageSnapshot?(): { promptTokens: number; outputTokens: number; totalTokens: number } | undefined;
}

interface BluedotMediaContextSource extends MeetingContextSource {
  mediaFromMeeting(meeting: MeetingEvidence, overrideUrl?: string): MediaSource;
}

export interface AnalysisEnginePorts {
  media: AnalysisVideoAnalyzer;
  propose(clock: SourceReceipt["clock"], digest: string, ...args: Parameters<AnalysisVideoAnalyzer["index"]>): Promise<{
    index: AnalysisIndex; document: CandidatesDocument; metadata: Map<string, IndexedMoment>;
  }>;
  grade: AnalysisVideoAnalyzer["interrogate"];
}

type WithoutMedia<T extends unknown[]> = T extends [unknown,...infer Args] ? Args : never;
/** A run binds each adapter to its own selected media before either role is invoked. */
export interface RecordingEngine {
  propose(...args:WithoutMedia<Parameters<AnalysisVideoAnalyzer["index"]>>):ReturnType<AnalysisEnginePorts["propose"]>;
  grade(...args:WithoutMedia<Parameters<AnalysisVideoAnalyzer["interrogate"]>>):Promise<AnalysisDetail>;
}
export interface AnalysisOrchestratorDependencies {
  createContextSource(options: ContextEnrichedAnalyzeOptions): MeetingContextSource;
  createEngines?(apiKey: string, options: AnalyzeOptions): AnalysisEnginePorts;
  createAnalyzer?(
    apiKey: string,
    options: AnalyzeOptions,
  ): AnalysisVideoAnalyzer;
  receiptDirectory?: string;
  withSourceRecording?: typeof withSourceRecording;
  createRunId?: () => string;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  extractScreenshot?: typeof extractScreenshot;
  buildContactSheet?: typeof buildContactSheet;
  decodeSpeechEnvelope?: typeof decodeSpeechEnvelope;
  extractAudioTrack?: typeof extractAudioTrack;
  probeDurationSeconds?: typeof probeDurationSeconds;
  calibrateClipClock?: typeof calibrateClipClock;
  probeFrameRate?: typeof probeFrameRate;
}

export type AnalyzeResult = PublishedAnalysisRun & {
  snapSummary?: ReturnType<typeof summarizeSnaps>;
  projectionWarning?: string;
};

export class AnalysisCanceledError extends Error {
  readonly code = "CANCELLED";
  constructor() {
    super("Analysis was canceled.");
    this.name = "AnalysisCanceledError";
  }
}

export class AnalysisOrchestrator {
  private readonly createContextSource: AnalysisOrchestratorDependencies["createContextSource"];
  private readonly createEngines: NonNullable<AnalysisOrchestratorDependencies["createEngines"]>;
  private readonly nextRunId: () => string;
  private readonly now: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly screenshot: typeof extractScreenshot;
  private readonly contactSheet: typeof buildContactSheet;
  private readonly decodeSpeech: typeof decodeSpeechEnvelope;
  private readonly extractAudio: typeof extractAudioTrack;
  private readonly probeDuration: typeof probeDurationSeconds;
  private readonly calibrate: typeof calibrateClipClock;
  private readonly sourceRecording: typeof withSourceRecording;
  private readonly frameRate: typeof probeFrameRate;

  constructor(private readonly dependencies: AnalysisOrchestratorDependencies) {
    this.createContextSource = dependencies.createContextSource;
    const legacyFactory = dependencies.createAnalyzer;
    if (dependencies.createEngines) this.createEngines = dependencies.createEngines;
    else if (legacyFactory) this.createEngines = (key, options) => geminiEnginePorts(legacyFactory(key,options));
    else throw new Error("No analysis engines registered.");
    this.nextRunId = dependencies.createRunId ?? createRunId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.screenshot = dependencies.extractScreenshot ?? extractScreenshot;
    this.contactSheet = dependencies.buildContactSheet ?? buildContactSheet;
    this.decodeSpeech = dependencies.decodeSpeechEnvelope ?? decodeSpeechEnvelope;
    this.extractAudio = dependencies.extractAudioTrack ?? extractAudioTrack;
    this.probeDuration = dependencies.probeDurationSeconds ?? probeDurationSeconds;
    this.calibrate = dependencies.calibrateClipClock ?? calibrateClipClock;
    this.sourceRecording = dependencies.withSourceRecording ?? withSourceRecording;
    this.frameRate = dependencies.probeFrameRate ?? probeFrameRate;
  }

  async analyze(options: AnalyzeOptions, execution: AnalyzeExecutionOptions = {}): Promise<AnalyzeResult> {
    return withMediaTransfer(() => this.run(options, execution));
  }

  private async run(options: AnalyzeOptions, execution: AnalyzeExecutionOptions): Promise<AnalyzeResult> {
    checkRoles(options, options.candidatesFile !== undefined, options.recipe.engines);
    const progress = execution.progress ?? NOOP_PROGRESS_REPORTER;
    const plan = enginePlan({...options, file:options.candidatesFile !== undefined, recipe:options.recipe.engines,
      model:options.model ?? (applicationSetting("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL),
      retention:options.retention ?? (options.keepUpload || options.remoteFileName ? "provider" : "run"),
      available:!!options.apiKey, twelveAvailable:!!options.twelvelabsKey, preview:false});
    if (!plan.used) throw new ContractError("KEY_MISSING", "Set a provider key before analysis.", {engine:"gemini"});
    const retryArgv = options.retryArgv ?? ["analyze", ...(options.video ? ["--video",options.video] : []),
      ...(options.from ? ["--from", options.from] : []), ...(options.to ? ["--to",options.to] : []),
      ...(options.candidatesFile ? ["--candidates",options.candidatesFile] : [])];
    if (!options.video) checkDirectUpload(plan, undefined, retryArgv);
    const tellRoute = (message: string) => report(progress, {kind:"stage",stage:"fetching_context",message});
    if (!execution.routeDisclosed) for (const line of disclosure(plan,options.recipe.twelveLabsSegments)) await tellRoute(line);
    if (plan.reason) await tellRoute(fallbackMessage(plan.reason));
    const settings = options.snapSettings && snapSettings(options.snapSettings.gapMs, options.snapSettings.windowMs);
    const requestedLanguage = resolveTranscriptLanguage(options.transcriptLanguage, options.derivedTranscript);
    const ranged = isRanged(options);
    if (ranged && options.remoteFileName) return rangeUsage("A range cannot reuse a remote file.");
    const sourceModeOnly = options.timelineOffset === undefined && /^from-media:(df|ndf)$/.test(options.timecodeRate ?? "");
    const timeline: ClockDeclaration | undefined = sourceModeOnly ? undefined : declareClock(options.timelineOffset, options.timecodeRate);
    const clock: RunClock = runClockSchema.parse({ fileClock: options.fileClock ?? "source", ...(timeline ? { timeline } : {}), modelClipClock: "unverified" });
    if (!ranged && !sourceModeOnly && options.video && options.timecodeRate?.startsWith("from-media")) {
      clock.timeline = declareClock(options.timelineOffset, options.timecodeRate, await this.frameRate(resolve(options.video), options.timecodeRate as "from-media" | "from-media:df" | "from-media:ndf"));
    }
    const maxVideoSeconds = resolveMaxVideoSeconds();
    const detailConcurrency = requireDetailConcurrency(options.detailConcurrency ?? 1);
    const runId = requireSafeRunId(this.nextRunId());
    const startedAt = this.now();
    const hasContext = hasMeetingContext(options);
    const context = hasContext ? this.createContextSource({...options, apiKey:"", twelvelabsKey:undefined}) : undefined;
    const temp = await createScratch("analyze", execution.jobScratchRoot);
    let meeting: MeetingEvidence | undefined;
    let localVideo = options.video ? resolve(options.video) : "";
    let downloadedMimeType: string | undefined;
    let mediaSource: RunManifest["mediaSource"] = "local-file";
    let stagingDirectory: string | undefined;
    let runContainerDirectory: string | undefined;
    let preparing: {recordingSha256: string; receipt?: SourceReceipt} | undefined;

    try {
      assertNotCanceled(execution.signal);
      await report(progress, {
        kind: "stage",
        stage: "fetching_context",
        message: hasContext
          ? "Fetching meeting context."
          : "No external context selected.",
      });
      const readMeeting = async () => {
        if (!context || !hasContext) throw new Error("Meeting context initialization failed.");
        await context.connect();
        assertNotCanceled(execution.signal);
        const evidence = await context.meeting(options.meetingId);
        if (!evidence) throw new Error("Meeting context provider returned no meeting evidence.");
        assertNotCanceled(execution.signal);
        return evidence;
      };
      if (hasContext) {
        if (!localVideo || !usesTwelveLabs(plan)) meeting = await readMeeting();
        if (!localVideo) {
          if (options.contextProvider !== "bluedot") {
            throw new Error(
              `${options.contextProvider} supplies meeting context, not a screen recording. ` +
                "Provide --video with a local recording.",
            );
          }
          if (!context || !isBluedotMediaContextSource(context)) {
            throw new Error("Bluedot context source cannot resolve recording media.");
          }
          const media = context.mediaFromMeeting(meeting!, options.recordingUrl);
          const extension = new URL(media.url).pathname.match(/\.(webm|mp4|m4v|mov|mp3)$/i)?.[0] || ".webm";
          localVideo = join(temp, `recording${extension}`);
          const download = await downloadFile(media.url, localVideo);
          assertNotCanceled(execution.signal);
          if (download.bytes === 0) {
            throw new Error("Downloaded recording is empty.");
          }
          downloadedMimeType = download.mimeType;
          mediaSource = media.source === "mcp" ? "bluedot-mcp" : "signed-url";
          await report(progress, {
            kind: "progress",
            stage: "fetching_context",
            progress: {
              completed: download.bytes,
              total: download.bytes,
              unit: "bytes",
            },
            message: `Downloaded ${(download.bytes / 1_000_000).toFixed(1)} MB recording.`,
          });
        }
      } else if (!localVideo) {
        throw new Error("A local recording is required when no external context is selected.");
      }

      const mimeType = mimeForPath(
        localVideo,
        options.videoMimeType ?? downloadedMimeType,
      );
      if (!/^(video|audio)\//.test(mimeType)) {
        throw new Error(
          `Unsupported recording type '${mimeType}'.`,
        );
      }
      const originalPath = localVideo;
      const recordingSha256 = await sha256File(originalPath);
      if (options.expectedVideoSha256 && recordingSha256 !== options.expectedVideoSha256) {
        throw new Error("Selected recording no longer matches its staged media receipt.");
      }
      preparing = {recordingSha256};
      const resolved = (clock: SourceReceipt["clock"]) => {
        const receipt = new SourceReceipt(clock, recordingSha256, maxVideoSeconds);
        if (preparing) preparing.receipt = receipt;
        return receipt;
      };
      return await this.sourceRecording(originalPath, {from:options.from,to:options.to,timecodeRate:options.timecodeRate,signal:execution.signal,onSourceResolved:resolved}, "analysis",
        line => process.stderr.write(line + "\n"), async (localVideo, sourceClock, hasAudio) => {
      const receipt = preparing?.receipt ?? resolved(sourceClock);
      const soundOnly = sourceClock.grid.unit === "samples";
      const recordingMimeType = soundOnly && ["video/mp4", "audio/mp4", "video/quicktime"].includes(mimeType)
        ? "audio/m4a" : soundOnly ? mimeType.replace(/^video\//, "audio/") : mimeType;
      const uploadMimeType = ranged ? (soundOnly ? "audio/wav" : "video/mp4") : recordingMimeType;
      if (soundOnly) await report(progress, {
        kind: "stage",
        stage: "fetching_context",
        message: "No picture. No stills are taken.",
      });
      const recording = recordingIdentity(sourceClock, recordingSha256);
      if (sourceClock.grid.unit === "ticks" && !sourceClock.lengthKnown && sourceClock.observedEnd === undefined) {
        throw new ContractError("INVALID_INPUT", "The stream has no timestamps.");
      }
      const fileRows = options.candidatesFile === undefined ? undefined :
        readCandidates(await loadCandidatesFile(options.candidatesFile), recording, "file", sourceClock.observedEnd);
      const uploadedCutSha256 = ranged ? await sha256File(localVideo) : undefined;
      const recordingSizeBytes = (await stat(localVideo)).size;
      if (options.video) {
        checkDirectUpload(plan, recordingSizeBytes, retryArgv, soundOnly);
        if (plan.reason === "media-limit") {
          await tellRoute(fallbackMessage(plan.reason));
          await tellRoute(soundOnly && recordingSizeBytes <= DIRECT_UPLOAD_BYTES ? soundOnlyHint : directUploadHint);
        }
      }
      if (recordingSizeBytes > MAX_RECORDING_BYTES) throw new Error("Recording exceeds the Gemini Files API 2 GB per-file limit.");
      const duration = ranged || soundOnly ? sourceClock.elapsed(sourceClock.to - sourceClock.from)
        : await this.probeDuration(localVideo, {signal:execution.signal});
      if (duration !== undefined && duration > maxVideoSeconds) {
        throw new ContractError("RECORDING_TOO_LONG",
          `Recording is ${duration} seconds long and the limit is ${maxVideoSeconds} seconds. Split the recording into shorter parts.`,
          {durationSeconds: duration, limitSeconds:maxVideoSeconds});
      }
      if (!sourceModeOnly && options.timecodeRate?.startsWith("from-media") && !clock.timeline) {
        const rate = ranged ? {rateOrigin:"media" as const,rate:sourceClock.grid.rate,dropFrame:sourceClock.grid.dropFrame ?? false}
          : await this.frameRate(originalPath, options.timecodeRate as "from-media" | "from-media:df" | "from-media:ndf");
        clock.timeline = declareClock(options.timelineOffset, options.timecodeRate, rate);
      }
      clock.clipGuard = duration === undefined ? "unknown-duration" : "applied";
      assertNotCanceled(execution.signal);
      if (hasContext && !meeting) meeting = await readMeeting();
      const containerId = meeting?.id ?? `video-${recordingSha256.slice(0, 16)}`;
      runContainerDirectory = join(resolve(options.outputRoot), safePathSegment(containerId));
      const outputDirectory = join(runContainerDirectory, runId);
      stagingDirectory = join(runContainerDirectory, `.${runId}.staging`);
      await ensureDirectory(runContainerDirectory);
      await ensureDirectory(stagingDirectory);

      const route = plan.used!;
      const engines = route.proposer.engine === "gemini" || route.grader.engine === "gemini"
        ? this.createEngines(options.apiKey, {...options, twelvelabsKey:undefined}) : undefined;
      const analyzer = engines?.media;
      const runModel = route.grader.engine === "gemini" ? analyzer!.model : PEGASUS_MODEL;
      const calls:EngineCall[] = [];
      const request = options.twelvelabsKey ? twelveTransport(options.twelvelabsKey) : undefined;
      const catalog = request && new ScratchReceipts(this.dependencies.receiptDirectory ?? receiptDirectory(),options.twelvelabsKey!,runId,this.now);
      if (catalog && request) await catalog.recover(request,tellRoute);
      const twelve = catalog && request ? new TwelveLabs(request,catalog,
        {path:localVideo,mime:ranged ? "video/mp4" : mimeType,bytes:recordingSizeBytes,duration,sha:recordingSha256,
          sentSha:uploadedCutSha256 ?? recordingSha256,clock:sourceClock},options.twelveLabsShape ?? "flat",options.indexWaitSeconds,
        this.now,this.sleep,tellRoute,execution.signal) : undefined;
      let finishedCopies = false;
      const finishCopies = async () => {
        if (!catalog || !request || finishedCopies) return;
        await catalog.finish(request);
        finishedCopies = true;
        if (catalog.copies.length) plan.receiptIds = catalog.copies.map(r=>r.receiptId);
        for (const copy of catalog.copies) await tellRoute("Twelve Labs scratch "+copy.receiptId+" "+copy.state+(copy.reason ? " ("+copy.reason+")" : "")+".");
      };
      const engineRecords = () => ({enginePlan:plan,engineCalls:calls,
        ...(catalog?.copies.length && {library:catalog.copies,indexWait:twelve!.indexWait})});
      const now = this.now;
      async function measured<T>(role:"proposer"|"grader",window:EngineCall["inferenceWindow"],work:()=>Promise<T>) {
        const actor = plan.used![role];
        const entry:EngineCall = {role,engine:actor.engine as EngineCall["engine"],model:actor.model!,
          material:role === "proposer" ? "selected recording and proposal instruction" : "selected recording, grading window and scoped evidence",
          sentExtent:[0,duration ?? null],inferenceWindow:window,utc:now(),bytes:recordingSizeBytes,state:"attempted",result:"failed"};
        calls.push(entry);
        try {
          const result = await work();
          entry.state="sent"; entry.result="complete";
          if (role==="proposer" && actor.engine==="twelvelabs" && twelve?.partial) {
            entry.result="partial"; entry.reason="proposal-incomplete";
          }
          return result;
        } catch (error) {
          const reason = error instanceof ContractError && engineReason.safeParse(error.details?.reason).data;
          entry.state = reason === "network" || reason === "request-timeout" ? "unknown" : "attempted";
          if (reason) entry.reason=reason;
          throw error;
        }
      }
      for (const route of [plan.planned, plan.used]) {
        if (route?.proposer.engine === "gemini") route.proposer.model = analyzer!.model;
        if (route?.grader.engine === "gemini") route.grader.model = analyzer!.model;
      }
      const {engine,model} = plan.used!.grader;
      const gradedBy = {engine,model};
      if (!soundOnly && options.calibrate !== false && route.proposer.engine !== "twelvelabs" && analyzer?.probeClipClock) {
        await tellRoute("Gemini may receive a synthetic calibration clip. The tool deletes that upload after measuring its clock.");
        const measured: Calibration = await this.calibrate({
          model: analyzer.model,
          tracksMediaRequests: true,
          upload: (path, mime) => uploadMedia(analyzer, path, mime),
          probeClipClock: (file) => analyzer.probeClipClock!(file),
          delete: (file) => analyzer.delete(file),
        });
        clock.modelClipClock = measured.result;
        clock.calibration = { model: measured.model, checkedAt: measured.checkedAt, method: "synthetic-flash" };
      }
      const tracer = execution.tracer ?? NOOP_ANALYSIS_TRACER;
      const chatAttributes: TraceAttributes = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "google_genai",
        "gen_ai.request.model": runModel,
      };
      const indexFps = requireIndexFps(options.indexFps ?? 0.5);
      if (options.model && analyzer && analyzer.model !== options.model) {
        throw new Error(
          "Resolved Gemini analyzer does not match the requested model.",
        );
      }

      // Quiet-line marks and optional snap proposals use the same whole-track classification.
      let trackMeasurement: ReturnType<typeof measureTrack> | undefined;
      const soundBoundaries = () => trackMeasurement ??= measureTrack(localVideo, this.decodeSpeech, {
        signal: execution.signal, ...(execution.jobScratchRoot && { confinedInput: true }),
      });
      let derivedTranscript: string | undefined;
      let derivedTranscriptProvenance: DerivedTranscriptProvenance | undefined;
      if (
        options.derivedTranscript !== false && hasAudio !== false
        && !meeting?.transcript?.trim()
        && route.proposer.engine !== "twelvelabs" && typeof analyzer?.transcribe === "function"
      ) {
        await report(progress, {
          kind: "stage",
          stage: "fetching_context",
          message: "Gemini receives the selected audio for transcription. The tool deletes each audio upload after use.",
        });
        // A single request cannot emit a verbatim transcript for a long
        // recording, so the audio is transcribed in bounded windows and
        // stitched back onto recording time. When the duration is unknown the
        // plan degrades to one window, matching the previous behavior.
        const windows = planTranscriptionWindows(
          duration ?? TRANSCRIPTION_WINDOW_SECONDS,
          TRANSCRIPTION_WINDOW_SECONDS,
          TRANSCRIPTION_OVERLAP_SECONDS,
        );
        const transcribed: Array<{
          segments: DerivedTranscriptionSegment[];
          nominalStartSeconds: number;
          nominalSourceIndex: bigint;
        }> = [];
        let transcriptionFailed = false;
        for (const [windowNumber, window] of windows.entries()) {
          assertNotCanceled(execution.signal);
          if (windows.length > 1) {
            await report(progress, {
              kind: "progress",
              stage: "fetching_context",
              progress: {
                completed: windowNumber,
                total: windows.length,
                unit: "items",
              },
              message: `Transcribing audio window ${windowNumber + 1}/${windows.length}…`,
            });
          }
          const grid = windowOnGrid(sourceClock, window, windowNumber === windows.length - 1);
          const audioStart = ranged ? sourceClock.elapsed(grid.start) : window.startSeconds;
          const audioDuration = duration === undefined ? undefined : ranged ? sourceClock.elapsed(grid.end - grid.start) : window.durationSeconds;
          const audioPath = join(temp, `derived-audio-${windowNumber + 1}.${ranged ? "wav" : "aac"}`);
          if (!(await this.extractAudio(localVideo, audioPath, {
            signal: execution.signal,
            ...(ranged && {pcm:true}),
            ...(audioStart ? { startSeconds: audioStart } : {}),
            ...(audioDuration === undefined ? {} : { durationSeconds: audioDuration }),
          }))) {
            await reportWarning(progress, {
              kind: "warning",
              stage: "fetching_context",
              message: windows.length > 1
                ? `Audio window ${windowNumber + 1}/${windows.length} could not be extracted; continuing without a transcript.`
                : "No audio track could be extracted; continuing without a transcript.",
            });
            transcriptionFailed = true;
            break;
          }
          assertNotCanceled(execution.signal);
          // The adapter already retries a single request across a transport
          // blip. This outer attempt exists for the case that survives that:
          // the provider shedding load for longer than one request's retry
          // budget. Losing one window discards the entire transcript, so the
          // window earns a second full upload-and-transcribe from the audio
          // already on disk.
          try {
            for (let attempt = 1; attempt <= TRANSCRIPTION_WINDOW_ATTEMPTS; attempt += 1) {
              assertNotCanceled(execution.signal);
              const finalAttempt = attempt === TRANSCRIPTION_WINDOW_ATTEMPTS;
              let audioRemote: GeminiFile | undefined;
              try {
                const segments = await tracer.span({
                  op: "gen_ai.chat",
                  name: "gemini transcribe",
                  attributes: {
                    ...chatAttributes,
                    "frame_of_mind.window": windowNumber + 1,
                    "frame_of_mind.windows": windows.length,
                  },
                }, async (span) => {
                  const usageBefore = usageCountsOf(analyzer);
                  try {
                    if (ranged && (await stat(audioPath)).size > MAX_RECORDING_BYTES) {
                      throw new ContractError("MEDIA_LIMIT", "Audio window exceeds the upload limit.");
                    }
                    audioRemote = await uploadMedia(analyzer, audioPath, ranged ? "audio/wav" : "audio/aac");
                    if (audioDuration !== undefined) receipt.uploads.push({kind:"audio-window",
                      span:[String(sourceClock.sourceIndex(grid.start)),String(sourceClock.sourceIndex(grid.end))], rate:sourceClock.grid.rate});
                    assertNotCanceled(execution.signal);
                    return await analyzer.transcribe!(audioRemote, requestedLanguage, audioDuration, ...(ranged ? [true] as const : []));
                  } finally {
                    span.setAttributes(
                      usageDeltaAttributes(usageBefore, usageCountsOf(analyzer)),
                    );
                  }
                });
                transcribed.push({
                  segments: offsetTranscriptionSegments(segments, 0, audioDuration).flatMap(segment => {
                    const start = timestampToSeconds(segment.start);
                    const end = timestampToSeconds(segment.end);
                    const exactSpan = modelSpan(sourceClock,start, Math.max(end,start+1), grid.start,
                      audioDuration === undefined ? sourceClock.cutLength : grid.end);
                    return exactSpan ? offsetTranscriptionSegments([{...segment, exactSpan}], window.startSeconds) : [];
                  }),
                  nominalSourceIndex:sourceClock.sourceIndex(grid.nominal),
                  nominalStartSeconds: window.nominalStartSeconds,
                });
                break;
              } catch (error) {
                if (error instanceof AnalysisCanceledError) throw error;
                const windowLabel = windows.length > 1
                  ? `audio window ${windowNumber + 1}/${windows.length}`
                  : "the recording audio";
                await reportWarning(progress, {
                  kind: "warning",
                  stage: "fetching_context",
                  message: finalAttempt
                    ? `Transcription failed on ${windowLabel} after ${TRANSCRIPTION_WINDOW_ATTEMPTS} attempts; continuing without a transcript.`
                    : `Transcription failed on ${windowLabel}; retrying once.`,
                });
                if (error instanceof GeminiFileError && error.uploadCleanup === "unconfirmed") {
                  await reportWarning(progress, {
                    kind: "warning",
                    stage: "cleaning_up",
                    message: "Derived-audio upload cleanup is unconfirmed; the temporary file expires with the provider retention window.",
                  });
                }
                if (finalAttempt) transcriptionFailed = true;
              } finally {
                if (audioRemote) {
                  if (!(await deleteWithRetry(analyzer, audioRemote, this.sleep))) {
                    await reportWarning(progress, {
                      kind: "warning",
                      stage: "cleaning_up",
                      message: "Derived-audio upload cleanup is unconfirmed; the temporary file expires with the provider retention window.",
                    });
                  }
                }
              }
              if (transcriptionFailed) break;
              await this.sleep(TRANSCRIPTION_WINDOW_RETRY_MS);
            }
          } finally {
            await rm(audioPath, { force: true });
          }
          if (transcriptionFailed) break;
          assertNotCanceled(execution.signal);
        }
        // A transcript with an unlabeled hole would misrepresent the meeting,
        // so a failed window discards the whole derived transcript rather than
        // publishing a partial one.
        if (!transcriptionFailed) {
          const warnings: string[] = [];
          const segments = mergeTranscriptionChunks(transcribed, message => warnings.push(message));
          const warn = (message: string) => reportWarning(progress, { kind: "warning", stage: "fetching_context", message });
          const boundaries = duration === undefined ? undefined : await soundBoundaries();
          assertNotCanceled(execution.signal);
          const marked = await markQuietLines(segments, boundaries, warn);
          const formatted = formatDerivedTranscript(marked.segments);
          if (formatted) {
            derivedTranscript = formatted;
            derivedTranscriptProvenance = {
              origin: "gemini-audio",
              model: analyzer!.model,
              sha256: sha256Text(marked.segments.map(line => {
                const span = line.exactSpan;
                return span ? `[${humanTime(span.start)} ${JSON.stringify(span)}] ${line.speaker}: ${line.text}` : "";
              }).join("\n")),
              ...(requestedLanguage && { requestedLanguage }),
            };
          }
          for (const message of warnings) {
            await reportWarning(progress, { kind: "warning", stage: "fetching_context", message });
          }
        }
        assertNotCanceled(execution.signal);
      } else if (requestedLanguage && meeting?.transcript?.trim()) {
        await report(progress, {
          kind: "stage",
          stage: "fetching_context",
          message: "A supplied transcript was available, so --transcript-language was not used.",
        });
      }

      const retainRemote = (options.retention
        ? options.retention === "provider"
        : options.keepUpload) || Boolean(options.remoteFileName);
      let remote: GeminiFile | undefined;
      let uploading: Promise<GeminiFile> | undefined;
      const uploadGemini = async () => {
        if (!analyzer) throw new Error("Gemini media transport is unavailable.");
      await report(progress, {
        kind: "stage",
        stage: "uploading_to_gemini",
        message: options.remoteFileName
          ? "Reusing the retained Gemini upload…"
          : "Uploading recording to Gemini Files API…",
      });
      assertNotCanceled(execution.signal);
        return tracer.span({
          op: "analysis.stage",
          name: "stage upload",
          attributes: {
            "frame_of_mind.stage": "upload",
            "frame_of_mind.byte_count": recordingSizeBytes,
          },
        }, async () => {
          if (options.remoteFileName) {
            if (typeof analyzer.resolveRetainedFile !== "function") {
              throw new GeminiFileError(
                "The configured analyzer cannot reuse a retained Gemini file.",
                options.remoteFileName,
                "not_obtained",
              );
            }
            mediaRequestStarted(); // The named file already has a remote lifecycle.
            return analyzer.resolveRetainedFile(
              options.remoteFileName,
              recordingSha256,
              recordingSizeBytes,
            );
          }
          const file = await uploadMedia(analyzer, localVideo, uploadMimeType);
          if (sourceClock.lengthKnown) receipt.uploads.push({kind:soundOnly ? "audio-window" : "video-cut", span:[String(sourceClock.from),String(sourceClock.to)],rate:sourceClock.grid.rate});
          return file;
        });
      };
      const geminiFile = () => uploading ??= uploadGemini().then(file=>(remote=file));
      const adapters:Partial<Record<"gemini"|"twelvelabs",RecordingEngine>> = {};
      if (engines) adapters.gemini = {
        propose:async (...args)=>engines.propose(sourceClock,recordingSha256,await geminiFile(),...args),
        grade:async (...args)=>engines.grade(await geminiFile(),...args),
      };
      if (twelve) adapters.twelvelabs = twelve;
      const adapterFor = (role:"proposer"|"grader") => {
        const engine = plan.used![role].engine;
        const adapter = (engine === "gemini" || engine === "twelvelabs") && adapters[engine];
        if (!adapter) throw new ContractError("CAPABILITY_MISSING","Selected engine is unavailable.",{engine});
        return adapter;
      };
      try {
        if (plan.used!.proposer.engine === "gemini" || (fileRows && route.grader.engine === "gemini")) await geminiFile();
      } catch (error) {
        if (error instanceof AnalysisCanceledError) throw error;
        assertNotCanceled(execution.signal);
        if (preparationDetails()) throw error;
        const reportedUploadCleanup = error instanceof GeminiFileError
          ? error.uploadCleanup ?? "unconfirmed"
          : "unconfirmed";
        const uploadName = error instanceof GeminiFileError
          ? sanitizedRemoteFileName(error.remoteFileName)
          : undefined;
        const uploadCleanup = reportedUploadCleanup === "confirmed_deleted" && !uploadName
          ? "unconfirmed"
          : reportedUploadCleanup;
        const failure = runFailureManifestSchema.parse({
          ...receipt.document(), ...(uploadedCutSha256 && {uploadedCutSha256}),
          schemaVersion: 1,
          ...engineRecords(),
          toolVersion: VERSION,
          runId,
          status: "failed",
          phase: "upload",
          startedAt,
          failedAt: this.now(),
          recipe: {
            id: options.recipe.id,
            revision: options.recipeRevision,
            sha256: options.recipeSha256,
          },
          model: runModel,
          recordingSha256,
          errorCode: faultCode(error),
          error: sanitizedFailureError(error),
          remoteFile: {
            ...(uploadCleanup !== "not_obtained" && uploadName
              ? { name: uploadName }
              : {}),
            cleanup: uploadCleanup,
          },
        });
        try {
          await rm(stagingDirectory, { recursive: true, force: true });
          await ensureDirectory(stagingDirectory);
          await writeFailureManifest(stagingDirectory, failure);
          await rename(stagingDirectory, outputDirectory);
          stagingDirectory = undefined;
          execution.onFailurePublished?.(outputDirectory,failure);
        } catch {
          await reportWarning(progress, {
            kind: "warning",
            stage: "cleaning_up",
            message: "The sanitized failure manifest could not be published.",
          });
        }
        if (uploadCleanup === "unconfirmed") {
          await reportUnconfirmedCleanup(progress, uploadName);
        }
        throw error;
      }
      let remoteDeleted = false;
      let cleanupFinalized = retainRemote;
      let failurePhase: AnalysisFailurePhase = "index";
      try {
        assertNotCanceled(execution.signal);
        await report(progress, {
          kind: "stage",
          stage: "indexing",
          message: "Pass 1/2: indexing the whole recording…",
        });
        assertNotCanceled(execution.signal);
        let indexMeeting = meeting;
        clock.transcriptWindow = "not-requested";
        if (ranged && meeting?.transcript.trim()) {
          const rebased = rangeTranscript(meeting, options.transcriptOffsetSeconds ?? 0, sourceClock, receipt);
          indexMeeting = {...meeting,transcript:rebased.text};
          clock.transcriptWindow = rebased.windowed ? "windowed" : "not-windowed";
        } else if (options.transcriptOffsetSeconds !== undefined && meeting?.transcript?.trim()) {
          const window = windowTranscript(meeting.transcript, options.transcriptOffsetSeconds, duration);
          indexMeeting = { ...meeting, transcript: window.text };
          clock.transcriptWindow = window.windowed ? "windowed" : "not-windowed";
          if (!window.windowed) await reportWarning(progress, { kind: "warning", stage: "indexing", message: "transcript not windowed: timestamped lines, a known video duration, and exact millisecond alignment are required." });
        }
        const proposeOnce = () => tracer.span({
          op: "gen_ai.chat",
          name: plan.used!.proposer.engine === "gemini" ? "gemini index" : "twelvelabs propose",
          attributes: {...chatAttributes,"gen_ai.provider.name":plan.used!.proposer.engine === "gemini" ? "google_genai" : "twelvelabs","gen_ai.request.model":plan.used!.proposer.model!},
        }, async (span) => {
          const usageBefore = usageCountsOf(analyzer);
          try {
            const hints: [notes?: readonly RunNote[], ranged?: boolean] = ranged ? [options.runNotes, true] : options.runNotes?.length ? [options.runNotes] : [];
            const indexed = await adapterFor("proposer").propose(
              indexMeeting,
              options.recipe,
              options.focus,
              indexFps,
              derivedTranscript,
              ...hints,
            );
            span.setAttributes({
              "frame_of_mind.candidates_indexed": indexed.index.moments.length,
            });
            return indexed;
          } finally {
            span.setAttributes(usageDeltaAttributes(usageBefore, usageCountsOf(analyzer)));
          }
        });
        const propose = async () => {
          const window:[number,number|null] = [0,duration ?? null];
          if (plan.used!.proposer.engine === "gemini") return measured("proposer",window,proposeOnce);
          try {
            return await measured("proposer",window,proposeOnce);
          } catch (error) {
            const reason = error instanceof ContractError && engineReason.safeParse(error.details?.reason).data;
            if (!reason || execution.signal?.aborted) throw error;
            if (!defaultDualRoute(plan)) throw new ContractError(error.code,error.message,{...error.details,retryWith:geminiRetry(retryArgv,false)});
            fallbackPlan(plan,reason);
            await tellRoute(fallbackMessage(reason));
            return measured("proposer",window,proposeOnce);
          }
        };
        const proposed = fileRows ? undefined : await propose();
        if (twelve?.partial) await reportWarning(progress,{kind:"warning",stage:"indexing",message:"proposal-incomplete: Twelve Labs returned partial coverage."});
        assertNotCanceled(execution.signal);
        const index: AnalysisIndex = proposed?.index ?? {matchNotes:"Candidates supplied in a file.",moments:[]};
        let alignment: RunManifest["transcriptAlignment"] | undefined;
        if (hasContext) {
          if (!fileRows && plan.used!.proposer.engine === "gemini" && !isMeetingAnalysisIndex(index)) {
            throw new Error("Gemini meeting analysis omitted transcript alignment metadata.");
          }
          if (isMeetingAnalysisIndex(index) && !index.isRelevantCall) {
            throw new Error(
              "Recording/transcript mismatch. Verify that the provider meeting ID and local recording refer to the same call.",
            );
          }
          if (derivedTranscriptProvenance && options.transcriptOffsetSeconds !== undefined) {
            await reportWarning(progress, {
              kind: "warning",
              stage: "indexing",
              message: "--transcript-offset was ignored: the derived transcript comes from this recording's audio and is aligned at offset 0 by construction.",
            });
          }
          alignment = derivedTranscriptProvenance
            ? {
                offsetSeconds: 0,
                method: "explicit",
                confidence: "high",
                rationale: "Transcript derived from this recording's audio; offset is 0 by construction.",
              }
            : options.transcriptOffsetSeconds === undefined
              ? !isMeetingAnalysisIndex(index) ? {
                  offsetSeconds: 0, method: "none", confidence: "none", rationale: fileRows ? "File input supplies no transcript alignment." : "The proposer supplied no transcript alignment.",
                } : {
                  offsetSeconds: index.transcriptAlignment.offsetSeconds,
                  method: index.transcriptAlignment.confidence === "none" ? "none" : "model",
                  confidence: index.transcriptAlignment.confidence,
                  rationale: index.transcriptAlignment.rationale,
                }
              : {
                  offsetSeconds: options.transcriptOffsetSeconds,
                  method: "explicit",
                  confidence: "high",
                  rationale: "Operator supplied --transcript-offset.",
                };
        }
        if (alignment) clock.transcriptClock = transcriptOffsetVerified(alignment.offsetSeconds, meeting?.transcript ?? derivedTranscript) ? "exact-ms" : "unverified";
        const providerTranscript = ranged ? indexMeeting?.transcript : meeting?.transcript?.trim() ? meeting.transcript : undefined;
        const effectiveTranscript = providerTranscript ?? derivedTranscript;
        const transcriptIsDerived = Boolean(derivedTranscript) && !providerTranscript;

        const runProseTime = ranged && [index.matchNotes, alignment?.rationale].some(hasProseTime);
        if (runProseTime) await reportWarning(progress,{kind:"warning",stage:"indexing",message:proseTimeNote});
        const items: AnalysisItem[] = [];
        const failures: CandidateFailure[] = [];
        const rows = fileRows ?? readCandidates(proposed!.document, recording, "engine", sourceClock.observedEnd);
        const proposalsByWindow = new Map<IndexedMoment, Candidate>();
        for (const row of rows) {
          const window = proposalWindow(row, sourceClock, proposed?.metadata.get(row.id));
          if (window && (duration === undefined || timestampToSeconds(window.start) < duration)) proposalsByWindow.set(window, row);
        }
        const inRange = [...proposalsByWindow.keys()];
        const indexedCount = fileRows?.length ?? (plan.used!.proposer.engine === "gemini" ? index.moments.length : rows.length);
        const outOfRange = indexedCount - inRange.length;
        const spanOf = (c: IndexedMoment) => modelSpan(sourceClock, timestampToSeconds(c.start), timestampToSeconds(c.end));
        const byTime = (a: IndexedMoment, b: IndexedMoment) => timestampToSeconds(a.start) - timestampToSeconds(b.start)
          || latestPosition(proposalsByWindow.get(a)!, "start") - latestPosition(proposalsByWindow.get(b)!, "start");
        const candidates = inRange.slice(0, options.maxIncidents).sort(byTime);
        failurePhase = "detail";
        await report(progress, {
          kind: "stage",
          stage: "interrogating",
          message: "Pass 2/2: interrogating indexed candidates…",
        });
        // Detail calls may overlap (bounded by `detailConcurrency`), but every
        // result is committed strictly in candidate order, so items,
        // screenshots, failure accounting, the circuit breaker, and progress
        // counts match a sequential run.
        type DetailAttempt =
          | { kind: "validated"; result: AnalysisDetail; stillTimes?: string[]; exactStillTimes?: Bound[]; citedStill?: string }
          | { kind: "failed"; error: CandidateAnalysisError }
          | { kind: "provider"; reason:import("../domain/engine-plan.js").EngineReason; attempts:0|1 };
        let stopped:import("../domain/engine-plan.js").EngineReason | undefined;
        // Admission counts completions rather than ordered commits: a slow
        // early request must not let faster failing workers refill forever.
        // Once an ordered result rules out a systematic leading failure, the
        // original per-candidate isolation policy can continue normally.
        let completedGenerationFailures = 0;
        const canStartDetail = () => completedGenerationFailures < GENERATION_FAILURE_CIRCUIT_BREAKER
          || items.length > 0
          || failures.some(failure => failure.code !== "generation_failed");
        const interrogateCandidate = async (
          candidate: IndexedMoment,
          indexNumber: number,
        ): Promise<DetailAttempt> => {
          assertNotCanceled(execution.signal);
          if (stopped) return {kind:"provider",reason:stopped,attempts:0};
          // CLI jobs account against a separate upload grant and omit inline images.
          const frames = soundOnly || execution.jobScratchRoot ? undefined : await extractDetailStills(
            localVideo, candidate, duration, temp, indexNumber, this.screenshot, () => assertNotCanceled(execution.signal), sourceClock,
          );
          let citedStill: string | undefined;
          try {
            const stills = frames && await Promise.all(frames.map(async ({ seconds, path }) => ({
              seconds, base64: await readFile(path, "base64"),
            })));
            assertNotCanceled(execution.signal);
            const result = await tracer.span({
              op: "gen_ai.chat",
              name: engine === "gemini" ? "gemini interrogate" : "twelvelabs grade",
              attributes: {
                ...chatAttributes,"gen_ai.provider.name":engine === "gemini" ? "google_genai" : "twelvelabs",
                "frame_of_mind.candidate_ordinal": indexNumber + 1,
              },
            }, async (span) => {
              // Cumulative-snapshot deltas are only attributable to this span
              // when no other detail call can overlap it.
              const usageBefore = detailConcurrency === 1 ? usageCountsOf(analyzer) : undefined;
              try {
                const row = proposalsByWindow.get(candidate)!;
                const window = engine === "gemini" ? clipWindow(candidate.start,candidate.end) :
                  {start:timestampToSeconds(candidate.start),end:timestampToSeconds(candidate.end)};
                if (engine === "gemini" && ranged && clock.modelClipClock === "unverified") {
                  window.start = 0;
                  window.end = duration!;
                }
                if (duration !== undefined) window.end = Math.min(window.end,duration);
                const detail = await measured("grader",[window.start,window.end],()=>adapterFor("grader").grade(
                  {start:candidate.start, end:candidate.end, ...(options.withholdGraderClaim ? {summary:"",withheld:true} : {summary:row.reason || row.label, surface:row.surface})},
                  effectiveTranscript && (alignment || transcriptIsDerived)
                    ? nearbyTranscript(
                        effectiveTranscript,
                        candidate.start,
                        candidate.end,
                        45,
                        transcriptIsDerived || ranged ? 0 : alignment?.offsetSeconds ?? 0,
                      )
                    : undefined,
                  options.recipe,
                  options.focus,
                  transcriptIsDerived,
                  options.runNotes,
                  clock.modelClipClock,
                  stills,
                  ...(ranged ? [duration] as [number|undefined] : []),
                ));
                span.setAttributes({ "frame_of_mind.candidate_accepted": detail.accepted });
                return detail;
              } catch (error) {
                if (error instanceof CandidateAnalysisError) {
                  if (error.code === "generation_failed") completedGenerationFailures += 1;
                  span.setAttributes({ "frame_of_mind.candidate_failure_code": error.code });
                }
                throw error;
              } finally {
                // Failed calls still consumed tokens; attach the delta before
                // the error propagates so failure-path spend stays queryable.
                if (usageBefore) {
                  span.setAttributes(usageDeltaAttributes(usageBefore, usageCountsOf(analyzer)));
                }
              }
            });
            if (!soundOnly && options.screenshots && result.accepted && result.evidence?.timestamp) {
              const seconds = timestampToSeconds(result.evidence.timestamp);
              citedStill = frames?.find(frame => frame.seconds === seconds)?.path;
            }
            return { kind: "validated", result, citedStill, exactStillTimes:frames?.map(f => f.exactTime!), stillTimes: frames?.map(frame => secondsToTimestamp(frame.seconds)) };
          } catch (error) {
            if (engine === "twelvelabs" && error instanceof ContractError) {
              const reason = engineReason.safeParse(error.details?.reason);
              if (reason.success) {
                if (reason.data !== "invalid-reply" && reason.data !== "media-limit") stopped = reason.data;
                await reportWarning(progress,{kind:"warning",stage:"interrogating",message:"Twelve Labs grading: "+reason.data+"."});
                return {kind:"provider",reason:reason.data,attempts:1};
              }
            }
            if (error instanceof CandidateAnalysisError) {
              return { kind: "failed", error };
            }
            throw error;
          } finally {
            for (const frame of frames ?? []) {
              if (frame.path !== citedStill) await rm(frame.path);
            }
          }
        };
        const screenshotDirectory = stagingDirectory;
        const commitCandidate = async (
          attempt: DetailAttempt,
          indexNumber: number,
        ): Promise<void> => {
          const candidate = candidates[indexNumber]!;
          const row = proposalsByWindow.get(candidate)!;
          const edges = proposalEdges(row, sourceClock);
          const exactSpan = spanOf(candidate)!;
          if (BigInt(edges.start.at) < sourceClock.from) exactSpan.start = sourceBound(sourceClock, sourceClock.from);
          const observedEnd = sourceClock.observedEnd;
          if (observedEnd !== undefined && BigInt(edges.end.at) > observedEnd) exactSpan.endExclusive = sourceBound(sourceClock, observedEnd);
          const provenance = {candidateId:row.id, proposedBy:row.proposedBy, gradedBy,proposal:row};
          const sourceCandidate = {...candidate, start:humanTime(exactSpan.start), end:humanTime(exactSpan.endExclusive), exactSpan, proposalEdges:edges};
          if (ranged && sourceClock.from > 0n && boundIndex(exactSpan.start) === sourceClock.from) {
            receipt.startFragments.push({kind:"moment",exactSpan,state:"unknown"});
          }
          if (ranged && sourceClock.to < sourceClock.grid.length && boundIndex(exactSpan.endExclusive) === sourceClock.to) {
            receipt.endFragments.push({kind:"moment",exactSpan,state:"unknown"});
          }
          try {
            if (attempt.kind === "provider") {
              failures.push({...provenance,gradedBy:attempt.attempts ? gradedBy : null,candidateOrdinal:indexNumber+1,
                proposalEdges:edges,exactSpan,start:sourceCandidate.start,end:sourceCandidate.end,code:"generation_failed",
                attempts:attempt.attempts,reason:attempt.reason});
              return;
            }
            if (attempt.kind === "failed") throw attempt.error;
            let result = attempt.result;
            if (attempt.stillTimes?.length === 0) {
              const notes = (result.confidenceNotes ?? "").slice(0, 10_000 - unavailableStillWarning.length - 1);
              result = { ...result, confidenceNotes: notes ? `${notes}\n${unavailableStillWarning}` : unavailableStillWarning };
            }
            // The request asks for screen words only from a labelled still. A
            // quote that cites any other time was not read from one: drop it.
            const cited = result.evidence?.timestamp;
            const screenTextNotFromStill = result.evidence?.verbatimUiText !== undefined
              && !(cited !== undefined && attempt.stillTimes?.some(time => timestampToSeconds(time) === timestampToSeconds(cited)));
            if (screenTextNotFromStill) {
              const { verbatimUiText: _removed, ...evidence } = result.evidence!;
              const notes = (result.confidenceNotes ?? "").slice(0, 10_000 - unreadScreenTextWarning.length - 1);
              result = { ...result, evidence, confidenceNotes: notes ? `${notes}\n${unreadScreenTextWarning}` : unreadScreenTextWarning };
            }
            assertNotCanceled(execution.signal);
            assertEvidenceWithinCandidate(
              result.evidence?.timestamp,
              candidate.start,
              candidate.end,
            );
            if (result.evidence?.timestamp) {
              const sec = timestampToSeconds(result.evidence.timestamp);
              const stillIndex = result.evidence.verbatimUiText !== undefined ? attempt.stillTimes?.indexOf(result.evidence.timestamp) ?? -1 : -1;
              const exactTime = attempt.exactStillTimes?.[stillIndex] ?? modelBound(sourceClock, sec, 0n, sourceClock.cutLength);
              if (boundIndex(exactTime) >= boundIndex(exactSpan.endExclusive)) {
                throw new CandidateAnalysisError({code:"evidence_out_of_range", attempts:1});
              }
              result = {...result, evidence:{...result.evidence, timestamp:humanTime(exactTime), exactTime}};
            }
            const item: AnalysisItem = { ...provenance, candidate: sourceCandidate, result };
            if (attempt.stillTimes) {
              item.exactStillTimes = attempt.exactStillTimes!;
              item.stillTimes = item.exactStillTimes.map(humanTime);
            }
            if (!soundOnly && screenTextNotFromStill) item.screenTextNotFromStill = true;
            if (!soundOnly && options.screenshots && result.accepted) {
              const stagingImage = join(screenshotDirectory,`moment-${indexNumber+1}-capture.png`);
              if (attempt.citedStill) {
                const i = attempt.stillTimes!.indexOf(cited!);
                item.screenshotExactTime = attempt.exactStillTimes![i];
                await rename(attempt.citedStill, stagingImage);
              } else {
                const position = {clock:sourceClock,span:exactSpan,target:result.evidence?.exactTime ?? exactSpan.start,
                  captured:(bound: Bound) => {item.screenshotExactTime=bound;}};
                await this.screenshot(localVideo,cited || candidate.start,stagingImage,
                  options.recipe.screenshotStrategy === "settled" ? {start:candidate.start,end:candidate.end} : undefined,position);
              }
              if (item.screenshotExactTime) {
                item.screenshot = `moment-${String(indexNumber+1).padStart(2,"0")}-${item.screenshotExactTime.unit}-${boundIndex(item.screenshotExactTime)}.png`;
                await rename(stagingImage,join(screenshotDirectory,item.screenshot));
              } else await rm(stagingImage,{force:true});
              assertNotCanceled(execution.signal);
            }
            if (ranged) markProseTime(item,runProseTime);
            items.push(item);
          } catch (error) {
            if (error instanceof AnalysisCanceledError) throw error;
            if (!(error instanceof CandidateAnalysisError)) throw error;
            failures.push({
              ...provenance, proposalEdges:edges,
              candidateOrdinal: indexNumber + 1,
              start: sourceCandidate.start,
              end: sourceCandidate.end, exactSpan,
              code: error.code,
              attempts: error.attempts,
              ...(error.issues.length ? { issues: [...error.issues] } : {}),
            });
            await reportWarning(progress, {
              kind: "warning",
              stage: "interrogating",
              message: error.code === "generation_failed"
                ? `Candidate ${indexNumber + 1} generation failed after bounded transport retries; continuing with remaining candidates.`
                : `Candidate ${indexNumber + 1} could not be validated after ${error.attempts} attempt${error.attempts === 1 ? "" : "s"}; continuing with remaining candidates.`,
            });
            // Circuit breaker for systematic failures: when the first few
            // candidates ALL fail at generation with nothing validated, the
            // fault is run-scoped (schema drift, revoked key), and grinding
            // through the remaining candidates only wastes provider calls.
            if (
              items.length === 0
              && failures.length >= GENERATION_FAILURE_CIRCUIT_BREAKER
              && failures.every((failure) => failure.code === "generation_failed")
            ) {
              throw new Error(
                `Gemini generation failed for the first ${failures.length} candidates; aborting as a systematic failure.`,
              );
            }
          }
          await report(progress, {
            kind: "progress",
            stage: "interrogating",
            progress: {
              completed: indexNumber + 1,
              total: candidates.length,
              unit: "items",
            },
            message: `Pass 2/2 [${indexNumber + 1}/${candidates.length}] at ${renderClockTime(sourceCandidate.start,clock,exactSpan.start)}`,
          });
        };
        await mapWithConcurrency(candidates, detailConcurrency, interrogateCandidate, {
          onResult: commitCandidate,
          canStart: canStartDetail,
          signal: execution.signal,
        });

        const omittedByLimit = inRange.length - candidates.length;
        if (omittedByLimit > 0) {
          await reportWarning(progress, {
            kind: "warning",
            stage: "interrogating",
            message:
              `Analysis truncated: ${omittedByLimit} indexed candidate(s) were not interrogated because of the configured moment limit (${options.maxIncidents}). ${fileRows ? "Lower-ranked" : "Lower-importance"} candidates were dropped; use --max-moments all to analyze every indexed candidate.`,
          });
        }
        const outcome = analysisOutcomeSchema.parse({
          ...(twelve?.partial && {proposalIncomplete:true}),
          schemaVersion: 2,
          runId,
          status: failures.length > 0 && items.length === 0
            ? "failed"
            : failures.length > 0 || omittedByLimit > 0 || twelve?.partial
              ? "partial"
              : "complete",
          candidates: {
            indexed: indexedCount,
            selected: candidates.length,
            omittedByLimit,
            ...(duration !== undefined || outOfRange > 0 ? { outOfRange } : {}),
            validated: items.length,
            accepted: items.filter((item) => item.result.accepted).length,
            rejected: items.filter((item) => !item.result.accepted).length,
            failed: failures.length,
          },
          failures,
        });

        let meetingRunContext: {
          meeting: MeetingEvidence;
          alignment: RunManifest["transcriptAlignment"];
        } | undefined;
        if (hasContext) {
          if (!meeting || !alignment) {
            throw new Error("Meeting context analysis did not produce complete provenance.");
          }
          meetingRunContext = { meeting, alignment };
        }

        const analysis: VersionedAnalysisRun = meetingRunContext
          ? {
              schemaVersion: 4,
              runId,
              recipe: {
                id: options.recipe.id,
                label: options.recipe.label,
              },
              meeting: {
                id: meetingRunContext.meeting.id,
                provider: meetingRunContext.meeting.provider,
                ...(meetingRunContext.meeting.title
                  ? { title: meetingRunContext.meeting.title }
                  : {}),
                ...(meetingRunContext.meeting.createdAt
                  ? { createdAt: meetingRunContext.meeting.createdAt }
                  : {}),
                ...(meetingRunContext.meeting.sourceUrl
                  ? { sourceUrl: meetingRunContext.meeting.sourceUrl }
                  : {}),
              },
              model: runModel,
              matchNotes: index.matchNotes,
              items,
            }
          : {
              schemaVersion: 5,
              runId,
              recipe: {
                id: options.recipe.id,
                label: options.recipe.label,
              },
              context: { mode: "none" },
              model: runModel,
              matchNotes: index.matchNotes,
              items,
            };
        failurePhase = "render";
        await report(progress, {
          kind: "stage",
          stage: "rendering",
          message: "Validating and rendering the analysis bundle.",
        });
        assertNotCanceled(execution.signal);
        let proposals: SnapRun | undefined;
        if (settings) {
          const windows = items.map(({candidate}) => {
            const claims = candidate.proposalEdges!;
            return {
              start:candidate.exactSpan!.start.origin === "cut" ? undefined : measurementSearch(claims,"start",sourceClock,settings.windowMs),
              end:candidate.exactSpan!.endExclusive.origin === "cut" ? undefined : measurementSearch(claims,"end",sourceClock,settings.windowMs),
            };
          });
          const shouldMeasure = windows.some(w => w.start !== undefined || w.end !== undefined);
          const boundaries = !shouldMeasure ? undefined : ranged ? await this.decodeSpeech(originalPath,{signal:execution.signal, slice:{
            startMs:boundMillis(sourceBound(sourceClock,sourceClock.from),true), endMs:boundMillis(sourceBound(sourceClock,sourceClock.to)),
          }}).then(envelope => envelope && classify(envelope)).catch(() => undefined) : await soundBoundaries();
          assertNotCanceled(execution.signal);
          if (shouldMeasure && !boundaries) await reportWarning(progress, { kind: "warning", stage: "rendering", message: "Speech snapping unavailable: audio decode or timestamp verification failed." });
          proposals = proposeRecords(items.map(({candidate}) => {
            const claims = candidate.proposalEdges!;
            return {start:boundMillis(sourceBound(sourceClock, BigInt(claims.start.at))),
              end:boundMillis(sourceBound(sourceClock, BigInt(claims.end.at)), true)};
          }), boundaries, clock.fileClock, settings, windows);
        }
        assertNotCanceled(execution.signal);
        failurePhase = "cleanup";
        await finishCopies();
        await report(progress, {
          kind: "stage",
          stage: "cleaning_up",
          message: retainRemote ? "Finalizing the analysis bundle." : "Deleting the temporary Gemini upload.",
        });
        if (remote && analyzer && !retainRemote) {
          remoteDeleted = await deleteWithRetry(analyzer, remote, this.sleep, execution.jobScratchRoot ? 1 : 3);
          cleanupFinalized = remoteDeleted || Boolean(execution.jobScratchRoot);
        }
        failurePhase = "render";
        const snappedBounds = new Map<string, Bound>();
        if (proposals) {
          const history = buildTimes(analysis, clock, proposals);
          if (history.schemaVersion === 3) for (const entry of history.entries) {
            if ("snap" in entry && entry.snap.status === "snapped" && entry.snap.exactTime) snappedBounds.set(entry.pointer, entry.snap.exactTime);
          }
        }
        items.forEach((item, i) => {
          const pointer = `/items/${i}/candidate/`;
          item.resolvedEdges = resolveEdges(item.candidate.exactSpan!, item.candidate.proposalEdges!, {
            start:snappedBounds.get(pointer + "start"), end:snappedBounds.get(pointer + "end"),
          });
        });
        const analysisSha256 = await analysisDigest(analysis);
        const promptProvenance = {
          indexPrefixSha256: await sha256Utf8(promptPrefix(options.recipe, "index")),
          interrogationPrefixSha256: await sha256Utf8(promptPrefix(options.recipe, "detail")),
          modelRouting: {
            requestedModel: runModel,
            // GEMINI_MODEL set to the default value is still an explicit
            // choice; only env-absent default-model runs report default-flash.
            reason: options.model
              ? "operator-selected" as const
              : applicationSetting("GEMINI_MODEL") || runModel !== DEFAULT_GEMINI_MODEL
                ? "environment-or-dependency-override" as const
                : "default-flash" as const,
          },
        };
        clock.relativeEvidenceResponses = analyzer?.relativeEvidenceResponses ?? 0;
        if (clock.modelClipClock === "absolute" && clock.relativeEvidenceResponses > 0) await reportWarning(progress, { kind: "warning", stage: "interrogating", message: "Evidence clock disagrees with the cached absolute calibration; rerun calibrate." });
        // One image tiling the moment screenshots (at most
        // CONTACT_SHEET_MAX_TILES), labelled with the record number used in
        // analysis.md and report.html. Nonfatal: the run completes without it.
        const sheetEntries = options.screenshots
          ? items
              .filter((item) => item.result.accepted)
              .flatMap((item, index) => item.screenshot
                ? [{
                    record: index + 1,
                    time: item.result.evidence?.timestamp || item.candidate.start,
                    screenshot: item.screenshot, actual:item.screenshotExactTime, cited:item.result.evidence?.exactTime ?? item.candidate.exactSpan?.start,
                  }]
                : [])
          : [];
        const contactSheet = sheetEntries.length
          ? await this.contactSheet(stagingDirectory!, sheetEntries).catch(() => undefined)
          : undefined;
        if (sheetEntries.length && !contactSheet) {
          await reportWarning(progress, {
            kind: "warning",
            stage: "rendering",
            message: "The contact sheet could not be built; the moment screenshots are still in the run folder.",
          });
        } else if (sheetEntries.length > CONTACT_SHEET_MAX_TILES) {
          await reportWarning(progress, {
            kind: "warning",
            stage: "rendering",
            message: `The contact sheet shows the first ${CONTACT_SHEET_MAX_TILES} of ${sheetEntries.length} screenshots; the rest are only in the run folder.`,
          });
        }
        assertNotCanceled(execution.signal);
        const tokenUsage = execution.includeTokenUsage ? analyzer?.measuredUsageByPass?.() : undefined;
        if (outcome.status === "complete" && sourceClock.lengthKnown) receipt.cover(sourceClock.from,sourceClock.to);
        else for (const {candidate} of items) {
          receipt.cover(boundIndex(candidate.exactSpan!.start),boundIndex(candidate.exactSpan!.endExclusive));
        }
        const proseTimeUnverified = runProseTime || (ranged && items.some(i => i.result.confidenceNotes?.includes(proseTimeNote)));
        const itemById = new Map(items.map(item => [item.candidateId,item]));
        const engineItems: EngineItems = candidates.map(window => {
          const row = proposalsByWindow.get(window)!;
          const item = itemById.get(row.id);
          const state = (edge: "start" | "endExclusive") => {
            if (!item?.resolvedEdges) return "failed";
            const origin = item.resolvedEdges[edge].bound.origin;
            if (origin === "snap") return "snapped";
            if (origin === "cut") return "cut";
            const claim = item.candidate.proposalEdges![edge === "start" ? "start" : "end"];
            if (settings && measurementWindow(claim,sourceClock,settings.windowMs) === undefined) return "skipped";
            return "claim";
          };
          return {candidateId:row.id,proposedBy:row.proposedBy,gradedBy:failures.find(f=>f.candidateId===row.id)?.attempts === 0 ? null : gradedBy,
            edges:{start:state("start"),end:state("endExclusive")}};
        });
        const manifestBase = {
          ...engineRecords(), engineItems,
          ...receipt.document(), ...(uploadedCutSha256 && {uploadedCutSha256}), ...(proseTimeUnverified && {proseTimeUnverified:true as const}),
          ...(tokenUsage && { tokenUsage }),
          clock,
          toolVersion: VERSION,
          runId,
          startedAt,
          completedAt: this.now(),
          recipe: {
            id: options.recipe.id,
            label: options.recipe.label,
            custom: options.customRecipe,
            revision: options.recipeRevision,
            sha256: options.recipeSha256,
          },
          model: runModel,
          ...(analyzer?.thinkingLevel && { thinkingLevel: analyzer.thinkingLevel }),
          recordingSha256,
          analysisSha256,
          recordingMimeType,
          ...(remote && {remoteFile:{...sanitizedRemoteFileMetadata(remote),deleted:remoteDeleted}}),
          analysis: {
            ...(options.focus ? { focus: options.focus } : {}),
            maxIncidents: options.maxIncidents,
            ...(!fileRows && {selection: "best-importance" as const}),
            indexFps,
            indexResolution: "low" as const,
            interrogationResolution: "medium" as const,
          },
          ...(options.runNotes?.length
            ? { runNotes: options.runNotes.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) }
            : {}),
          ...(derivedTranscriptProvenance
            ? { derivedTranscript: derivedTranscriptProvenance }
            : {}),
          promptProvenance,
          ...(options.label ? { label: options.label } : {}),
          artifacts: [
            "analysis.json",
            "analysis-outcome.json",
            "analysis.md",
            "report.html",
            "manifest.json",
            "times.json",
            ...items.flatMap((item) => (item.screenshot ? [item.screenshot] : [])),
            ...(contactSheet ? [contactSheet] : []),
          ],
        };
        const manifest: VersionedRunManifest = meetingRunContext
          ? {
              ...manifestBase,
              schemaVersion: 2,
              promptRevision: "2026-08-11.1",
              meetingId: meetingRunContext.meeting.id,
              transcriptSha256: derivedTranscriptProvenance
                ? derivedTranscriptProvenance.sha256
                : sha256Text(meetingRunContext.meeting.transcript),
              contextProvider: meetingRunContext.meeting.provider,
              contextTransport: meetingRunContext.meeting.transport,
              mediaSource,
              transcriptAlignment: meetingRunContext.alignment,
            }
          : {
              ...manifestBase,
              schemaVersion: 3,
              promptRevision: "2026-08-11.1",
              context: { mode: "none" },
              mediaSource: "local-file",
            };
        const validated = await validateVersionedRunImport({ analysis, manifest });
        assertNotCanceled(execution.signal);
        await tracer.span({
          op: "analysis.stage",
          name: "stage publish",
          attributes: {
            "frame_of_mind.stage": "publish",
            "frame_of_mind.outcome": outcome.status,
            "frame_of_mind.candidates_indexed": outcome.candidates.indexed,
            "frame_of_mind.candidates_selected": outcome.candidates.selected,
            "frame_of_mind.candidates_omitted_by_limit": outcome.candidates.omittedByLimit,
            "frame_of_mind.candidates_validated": outcome.candidates.validated,
            "frame_of_mind.candidates_accepted": outcome.candidates.accepted,
            "frame_of_mind.candidates_rejected": outcome.candidates.rejected,
            "frame_of_mind.candidates_failed": outcome.candidates.failed,
          },
        }, async () => {
          await writeArtifacts(
            stagingDirectory!,
            validated.analysis,
            validated.manifest,
            outcome,
            proposals,
          );
          assertNotCanceled(execution.signal);
          await rename(stagingDirectory!, outputDirectory);
        });
        stagingDirectory = undefined;
        // Once the bundle is published its cleanup state must remain immutable.
        // Failed cleanup may be retried in `finally` only while publication has
        // not completed and no durable manifest exists.
        cleanupFinalized = true;
        if (remote && analyzer && !retainRemote && !remoteDeleted) {
          await reportWarning(progress, {
            kind: "warning",
            stage: "cleaning_up",
            message: "Gemini file cleanup failed; manifest records deleted=false.",
          });
        }
        const published: PublishedAnalysisRun = {...validated, directory:outputDirectory, outcome};
        let projectionWarning: string | undefined;
        if (execution.projection) {
          try {
            await execution.projection.publish(
              structuredClone({...validated, outcome}),
            );
          } catch {
            projectionWarning = "Published run could not be added to the review projection.";
            await reportWarning(progress, {
              kind: "warning",
              stage: "cleaning_up",
              message: projectionWarning,
            });
          }
        }
        return {
          ...published,
          ...(proposals ? { snapSummary: summarizeSnaps(proposals) } : {}),
          ...(projectionWarning ? { projectionWarning } : {}),
        };
      } catch (error) {
        await finishCopies();
        if ((error instanceof AnalysisCanceledError || execution.signal?.aborted) && (execution.jobScratchRoot || !catalog?.copies.length)) throw error;
        if (remote && analyzer && !retainRemote && !cleanupFinalized) {
          remoteDeleted = await deleteWithRetry(analyzer, remote, this.sleep, execution.jobScratchRoot ? 1 : 3);
          cleanupFinalized = true;
        }
        const failure = runFailureManifestSchema.parse({
          ...receipt.document(), ...(uploadedCutSha256 && {uploadedCutSha256}),
          schemaVersion: 1,
          ...engineRecords(),
          toolVersion: VERSION,
          runId,
          status: "failed",
          phase: failurePhase,
          startedAt,
          failedAt: this.now(),
          recipe: {
            id: options.recipe.id,
            revision: options.recipeRevision,
            sha256: options.recipeSha256,
          },
          model: runModel,
          recordingSha256,
          errorCode: faultCode(error),
          error: sanitizedFailureError(error),
          remoteFile: {
            ...(remote && sanitizedRemoteFileMetadata(remote)),
            cleanup: !remote ? "not_obtained" : retainRemote
              ? "intentionally_retained"
              : remoteDeleted
                ? "confirmed_deleted"
                : "unconfirmed",
          },
        });
        if (stagingDirectory) {
          try {
            await rm(stagingDirectory, { recursive: true, force: true });
            await ensureDirectory(stagingDirectory);
            await writeFailureManifest(stagingDirectory, failure);
            await rename(stagingDirectory, outputDirectory);
            stagingDirectory = undefined;
            execution.onFailurePublished?.(outputDirectory,failure);
          } catch {
            await reportWarning(progress, {
              kind: "warning",
              stage: "cleaning_up",
              message: "The sanitized failure manifest could not be published.",
            });
          }
        }
        if (remote && analyzer && !retainRemote && !remoteDeleted) {
          await reportUnconfirmedCleanup(
            progress,
            sanitizedRemoteFileMetadata(remote).name,
          );
        }
        throw error;
      } finally {
        await finishCopies();
        if (remote && analyzer && !retainRemote && !cleanupFinalized) {
          const deleted = await deleteWithRetry(analyzer, remote, this.sleep, execution.jobScratchRoot ? 1 : 3);
          if (!deleted) {
            await reportWarning(progress, {
              kind: "warning",
              stage: "cleaning_up",
              message: "Gemini file cleanup did not complete after analysis failure.",
            });
          }
        }
      }
      });
    } catch (error) {
      if (preparing && preparationDetails() && !execution.signal?.aborted) {
        const source = preparing.receipt?.document() ?? {recordingSha256:preparing.recordingSha256, coverage:{full:false, covered:[]}};
        const tell = execution.jobScratchRoot ? undefined : (line: string) => process.stderr.write(line + "\n");
        throw preparationError(error, source, tell, !ranged);
      }
      throw error;
    } finally {
      await context?.close().catch(() => undefined);
      if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
      if (runContainerDirectory) await rmdir(runContainerDirectory).catch(() => undefined);
      if (!execution.jobScratchRoot) await rm(temp, { recursive: true, force: true });
    }
  }
}

export async function analyzeMeeting(
  options: AnalyzeOptions,
  execution: AnalyzeExecutionOptions = {},
): Promise<AnalyzeResult> {
  return createDefaultAnalysisOrchestrator().analyze(options, execution);
}

export function createDefaultAnalysisOrchestrator(): AnalysisOrchestrator {
  return new AnalysisOrchestrator({
    createContextSource: defaultCreateContextSource,
    createEngines: (apiKey, analyzeOptions) => geminiEnginePorts(
      new GeminiVideoAnalyzer(apiKey, analyzeOptions.model ?? (applicationSetting("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL), {}, analyzeOptions.thinkingLevel)),
  });
}

function defaultCreateContextSource(options: ContextEnrichedAnalyzeOptions): MeetingContextSource {
  const interactive = options.interactiveProviderAuth ?? true;
  if (options.contextProvider === "bluedot") {
    return new BluedotClient(applicationSetting("BLUEDOT_MCP_URL"), interactive, interactive);
  }
  if (options.contextProvider === "granola") {
    return options.granolaTransport === "api"
      ? new GranolaApiClient(options.granolaApiKey ?? applicationSetting("GRANOLA_API_KEY"))
      : new GranolaClient(applicationSetting("GRANOLA_MCP_URL"), interactive, interactive);
  }
  if (!options.contextFile) throw new Error("--context-file is required when --source file is selected.");
  return new FileContextSource(options.contextFile);
}

async function deleteWithRetry(
  analyzer: AnalysisVideoAnalyzer,
  remote: GeminiFile,
  sleep: (milliseconds: number) => Promise<void>,
  attempts = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await analyzer.delete(remote);
      return true;
    } catch {
      if (attempt + 1 < attempts) await sleep(500 * (attempt + 1));
    }
  }
  return false;
}

const NOOP_PROGRESS_REPORTER: AnalysisProgressReporter = {
  report() {
    // Deliberately empty for library consumers that do not need progress.
  },
};

async function report(reporter: AnalysisProgressReporter, event: AnalysisProgressEvent): Promise<void> {
  await reporter.report(event);
}

async function reportWarning(
  reporter: AnalysisProgressReporter,
  event: Extract<AnalysisProgressEvent, { kind: "warning" }>,
): Promise<void> {
  try {
    await reporter.report(event);
  } catch {
    // A warning sink cannot invalidate a published run or mask a prior failure.
  }
}

function sanitizedFailureError(error: unknown): RunFailureManifest["error"] {
  if (error instanceof CandidateAnalysisError) {
    return {
      code: error.code,
      attempts: error.attempts,
      ...(error.issues.length ? { issues: [...error.issues] } : {}),
    };
  }
  return {
    code: "unexpected_failure",
    ...(error instanceof GeminiFileError && error.provider ? { provider: { class: error.provider.class, status: error.provider.status } } : {}),
  };
}

function sanitizedRemoteFileMetadata(
  remote: GeminiFile,
): Pick<RunFailureManifest["remoteFile"], "name" | "expirationTime"> {
  const name = sanitizedRemoteFileName(remote.name);
  return {
    ...(name
      ? { name }
      : {}),
    ...(remote.expirationTime && isUtcDateTime(remote.expirationTime)
      ? { expirationTime: remote.expirationTime }
      : {}),
  };
}

function sanitizedRemoteFileName(value: string | undefined): string | undefined {
  return value && value.length <= 1_000 && /^files\/[A-Za-z0-9_-]+$/.test(value)
    ? value
    : undefined;
}

function isUtcDateTime(value: string): boolean {
  return value.length <= 120
    && z.string().datetime({ offset: false }).safeParse(value).success;
}

async function reportUnconfirmedCleanup(
  progress: AnalysisProgressReporter,
  remoteFileName?: string,
): Promise<void> {
  await reportWarning(progress, {
    kind: "warning",
    stage: "cleaning_up",
    message: remoteFileName
      ? "Gemini file cleanup is unconfirmed; inspect the private failure-manifest.json for exact-file recovery."
      : "Gemini file cleanup is unconfirmed and its remote identity is unavailable; review the provider account after the upload retention window.",
  });
}

function assertNotCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalysisCanceledError();
}

function requireSafeRunId(value: string): string {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/.test(value) ||
    safePathSegment(value) !== value
  ) {
    throw new Error("Generated run ID is not a safe path segment.");
  }
  return value;
}

export const MAX_DETAIL_CONCURRENCY = 8;

function requireDetailConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DETAIL_CONCURRENCY) {
    throw new Error(`Detail concurrency must be an integer from 1 to ${MAX_DETAIL_CONCURRENCY}.`);
  }
  return value;
}

function requireIndexFps(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 60) {
    throw new Error("Gemini index FPS must be greater than 0 and at most 60.");
  }
  return value;
}

function isBluedotMediaContextSource(context: MeetingContextSource): context is BluedotMediaContextSource {
  return "mediaFromMeeting" in context && typeof context.mediaFromMeeting === "function";
}

function hasMeetingContext(
  options: AnalyzeOptions,
): options is ContextEnrichedAnalyzeOptions {
  return options.contextMode !== "none";
}

function isMeetingAnalysisIndex(
  index: AnalysisIndex,
): index is MeetingAnalysisIndex {
  return "isRelevantCall" in index && "transcriptAlignment" in index;
}

type TracedUsageCounts = { promptTokens: number; outputTokens: number; totalTokens: number };

function usageCountsOf(analyzer: AnalysisVideoAnalyzer | undefined): TracedUsageCounts | undefined {
  return typeof analyzer?.usageSnapshot === "function" ? analyzer.usageSnapshot() : undefined;
}

function usageDeltaAttributes(
  before: TracedUsageCounts | undefined,
  after: TracedUsageCounts | undefined,
): TraceAttributes {
  if (!before || !after) return {};
  const input = after.promptTokens - before.promptTokens;
  const output = after.outputTokens - before.outputTokens;
  const total = after.totalTokens - before.totalTokens;
  if (![input, output, total].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    return {};
  }
  return {
    "gen_ai.usage.input_tokens": input,
    "gen_ai.usage.output_tokens": output,
    "gen_ai.usage.total_tokens": total,
  };
}

const proseTimeNote = "A time in this text may be on the cut's clock.";
const hasProseTime = (s: string | undefined) => !!s && /\b(?:\d+:)?\d{1,2}:[0-5]\d\b/.test(s);
function markProseTime(item: AnalysisItem, runLevel: boolean) {
  const {candidate:c,result:r} = item;
  const prose = [c.summary,c.speaker,c.kind,c.surface,r.title,r.kind,r.summary,r.confidenceNotes,r.where?.step,r.where?.surface,
    r.evidence?.verbatimUiText,r.evidence?.reporterQuote,r.evidence?.speaker,...r.steps ?? [],...(r.details ?? []).flatMap(d => [d.label,d.value])];
  const note = proseTimeNote;
  if (!runLevel && !prose.some(hasProseTime)) return false;
  if (!r.confidenceNotes?.includes(note)) r.confidenceNotes = [r.confidenceNotes,note].filter(Boolean).join("\n");
  return true;
}

export function assertEvidenceWithinCandidate(
  evidenceTimestamp: string | undefined,
  candidateStart: string,
  candidateEnd: string,
): void {
  if (!evidenceTimestamp) return;
  const evidence = timestampToSeconds(evidenceTimestamp);
  if (evidence < timestampToSeconds(candidateStart) || evidence > timestampToSeconds(candidateEnd)) {
    throw new CandidateAnalysisError({
      code: "evidence_out_of_range",
      attempts: 1,
    });
  }
}
