import { mkdtemp, rename, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { File as GeminiFile } from "@google/genai";
import { z } from "zod";
import type {
  AnalysisDetail,
  AnalysisRecipe,
  AnalysisRun,
  AnalysisRunV3,
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
  isRunImportV2,
  isRunImportV3,
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
  mergeTranscriptionChunks,
  nearbyTranscript,
  offsetTranscriptionSegments,
} from "./transcript.js";
import {
  extractAudioTrack,
  planTranscriptionWindows,
  probeDurationSeconds,
} from "./audio.js";
import { extractScreenshot } from "./screenshots.js";
import { writeArtifacts, writeFailureManifest } from "./artifacts.js";
import { timestampToSeconds } from "../lib/time.js";
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

// Verbatim transcription is bounded by the model's output budget, not the
// audio length, so long recordings are transcribed in windows with a short
// lead-in overlap for boundary context.
const TRANSCRIPTION_WINDOW_SECONDS = 600;
const TRANSCRIPTION_OVERLAP_SECONDS = 15;
// One failed window discards the whole transcript, so a window that exhausts
// the adapter's per-request retries is re-uploaded and transcribed once more
// after a pause long enough to outlast a load-shedding episode.
const TRANSCRIPTION_WINDOW_ATTEMPTS = 2;
const TRANSCRIPTION_WINDOW_RETRY_MS = 20_000;

interface AnalyzeOptionsBase {
  recipe: AnalysisRecipe;
  customRecipe: boolean;
  recipeSha256: string;
  recipeRevision: string;
  apiKey: string;
  model?: string;
  video?: string;
  videoMimeType?: string;
  expectedVideoSha256?: string;
  recordingUrl?: string;
  focus?: string;
  indexFps?: number;
  outputRoot: string;
  maxIncidents: number;
  screenshots: boolean;
  keepUpload: boolean;
  /**
   * Reuse an operator-retained Gemini Files API upload (`files/...`) for this
   * exact recording instead of uploading again. The run never deletes a file
   * it did not create.
   */
  remoteFileName?: string;
  derivedTranscript?: boolean;
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

export type AnalysisProjectionInput =
  | { analysis: AnalysisRun; manifest: RunManifest; outcome?: AnalysisOutcome }
  | { analysis: AnalysisRunV3; manifest: RunManifestV3; outcome?: AnalysisOutcome };

export type PublishedAnalysisRun = AnalysisProjectionInput & {
  readonly directory: string;
  readonly outcome: AnalysisOutcome;
};

export interface AnalysisProjectionPublisher {
  publish(run: AnalysisProjectionInput): Promise<void>;
}

export interface AnalyzeExecutionOptions {
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
  readonly model: string;
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
  ): Promise<AnalysisIndex>;
  interrogate(
    file: GeminiFile,
    candidate: IndexedMoment,
    nearbyTranscript: string | undefined,
    recipe: AnalysisRecipe,
    focus?: string,
    transcriptDerived?: boolean,
  ): Promise<AnalysisDetail>;
  transcribe?(file: GeminiFile): Promise<DerivedTranscriptionSegment[]>;
  delete(file: GeminiFile): Promise<void>;
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

export interface AnalysisOrchestratorDependencies {
  createContextSource(options: ContextEnrichedAnalyzeOptions): MeetingContextSource;
  createAnalyzer(
    apiKey: string,
    options: AnalyzeOptions,
  ): AnalysisVideoAnalyzer;
  createRunId?: () => string;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  extractScreenshot?: typeof extractScreenshot;
  extractAudioTrack?: typeof extractAudioTrack;
  probeDurationSeconds?: typeof probeDurationSeconds;
}

export type AnalyzeResult = PublishedAnalysisRun & {
  projectionWarning?: string;
};

export class AnalysisCanceledError extends Error {
  constructor() {
    super("Analysis was canceled.");
    this.name = "AnalysisCanceledError";
  }
}

export class AnalysisOrchestrator {
  private readonly createContextSource: AnalysisOrchestratorDependencies["createContextSource"];
  private readonly createAnalyzer: AnalysisOrchestratorDependencies["createAnalyzer"];
  private readonly nextRunId: () => string;
  private readonly now: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly screenshot: typeof extractScreenshot;
  private readonly extractAudio: typeof extractAudioTrack;
  private readonly probeDuration: typeof probeDurationSeconds;

  constructor(dependencies: AnalysisOrchestratorDependencies) {
    this.createContextSource = dependencies.createContextSource;
    this.createAnalyzer = dependencies.createAnalyzer;
    this.nextRunId = dependencies.createRunId ?? createRunId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.screenshot = dependencies.extractScreenshot ?? extractScreenshot;
    this.extractAudio = dependencies.extractAudioTrack ?? extractAudioTrack;
    this.probeDuration = dependencies.probeDurationSeconds ?? probeDurationSeconds;
  }

  async analyze(options: AnalyzeOptions, execution: AnalyzeExecutionOptions = {}): Promise<AnalyzeResult> {
    const runId = requireSafeRunId(this.nextRunId());
    const startedAt = this.now();
    const hasContext = hasMeetingContext(options);
    const context = hasContext ? this.createContextSource(options) : undefined;
    const progress = execution.progress ?? NOOP_PROGRESS_REPORTER;
    const temp = await mkdtemp(join(tmpdir(), "frame-of-mind-"));
    let meeting: MeetingEvidence | undefined;
    let localVideo = options.video ? resolve(options.video) : "";
    let downloadedMimeType: string | undefined;
    let mediaSource: RunManifest["mediaSource"] = "local-file";
    let stagingDirectory: string | undefined;
    let runContainerDirectory: string | undefined;

    try {
      assertNotCanceled(execution.signal);
      await report(progress, {
        kind: "stage",
        stage: "fetching_context",
        message: hasContext
          ? "Fetching meeting context."
          : "No external context selected.",
      });
      if (hasContext) {
        if (!context) {
          throw new Error("Meeting context initialization failed.");
        }
        await context.connect();
        assertNotCanceled(execution.signal);
        meeting = await context.meeting(options.meetingId);
        if (!meeting) {
          throw new Error("Meeting context provider returned no meeting evidence.");
        }
        assertNotCanceled(execution.signal);
        if (!localVideo) {
          if (options.contextProvider !== "bluedot") {
            throw new Error(
              `${options.contextProvider} supplies meeting context, not a screen recording. ` +
                "Provide --video with a local recording.",
            );
          }
          if (!isBluedotMediaContextSource(context)) {
            throw new Error("Bluedot context source cannot resolve recording media.");
          }
          const media = context.mediaFromMeeting(meeting, options.recordingUrl);
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
      if (!mimeType.startsWith("video/")) {
        throw new Error(
          `Frame of Mind requires a screen recording; received '${mimeType}'. ` +
            "Audio-only calls have no visual UI evidence to interrogate.",
        );
      }
      const recordingSizeBytes = (await stat(localVideo)).size;
      if (recordingSizeBytes > MAX_RECORDING_BYTES) {
        throw new Error("Recording exceeds the Gemini Files API 2 GB per-file limit.");
      }
      const recordingSha256 = await sha256File(localVideo);
      if (
        options.expectedVideoSha256
        && recordingSha256 !== options.expectedVideoSha256
      ) {
        throw new Error(
          "Selected recording no longer matches its staged media receipt.",
        );
      }
      assertNotCanceled(execution.signal);
      const containerId = meeting?.id ?? `video-${recordingSha256.slice(0, 16)}`;
      runContainerDirectory = join(resolve(options.outputRoot), safePathSegment(containerId));
      const outputDirectory = join(runContainerDirectory, runId);
      stagingDirectory = join(runContainerDirectory, `.${runId}.staging`);
      await ensureDirectory(runContainerDirectory);
      await ensureDirectory(stagingDirectory);

      const analyzer = this.createAnalyzer(options.apiKey, options);
      const tracer = execution.tracer ?? NOOP_ANALYSIS_TRACER;
      const chatAttributes: TraceAttributes = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "google_genai",
        "gen_ai.request.model": analyzer.model,
      };
      const indexFps = requireIndexFps(options.indexFps ?? 0.5);
      if (options.model && analyzer.model !== options.model) {
        throw new Error(
          "Resolved Gemini analyzer does not match the requested model.",
        );
      }

      let derivedTranscript: string | undefined;
      let derivedTranscriptProvenance: DerivedTranscriptProvenance | undefined;
      if (
        options.derivedTranscript !== false
        && !meeting?.transcript?.trim()
        && typeof analyzer.transcribe === "function"
      ) {
        await report(progress, {
          kind: "stage",
          stage: "fetching_context",
          message: "Deriving a transcript from the recording audio…",
        });
        // A single request cannot emit a verbatim transcript for a long
        // recording, so the audio is transcribed in bounded windows and
        // stitched back onto recording time. When the duration is unknown the
        // plan degrades to one window, matching the previous behavior.
        const duration = await this.probeDuration(localVideo, { signal: execution.signal });
        assertNotCanceled(execution.signal);
        const windows = planTranscriptionWindows(
          duration ?? TRANSCRIPTION_WINDOW_SECONDS,
          TRANSCRIPTION_WINDOW_SECONDS,
          TRANSCRIPTION_OVERLAP_SECONDS,
        );
        const transcribed: Array<{
          segments: DerivedTranscriptionSegment[];
          nominalStartSeconds: number;
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
          const audioPath = join(temp, `derived-audio-${windowNumber + 1}.aac`);
          if (!(await this.extractAudio(localVideo, audioPath, {
            signal: execution.signal,
            ...(window.startSeconds ? { startSeconds: window.startSeconds } : {}),
            ...(duration === undefined ? {} : { durationSeconds: window.durationSeconds }),
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
                  audioRemote = await analyzer.upload(audioPath, "audio/aac");
                  assertNotCanceled(execution.signal);
                  const transcribed = await analyzer.transcribe!(audioRemote);
                  span.setAttributes(
                    usageDeltaAttributes(usageBefore, usageCountsOf(analyzer)),
                  );
                  return transcribed;
                });
                transcribed.push({
                  segments: offsetTranscriptionSegments(segments, window.startSeconds),
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
          const formatted = formatDerivedTranscript(mergeTranscriptionChunks(transcribed));
          if (formatted) {
            derivedTranscript = formatted;
            derivedTranscriptProvenance = {
              origin: "gemini-audio",
              model: analyzer.model,
              sha256: sha256Text(formatted),
            };
          }
        }
        assertNotCanceled(execution.signal);
      }

      const retainRemote = options.keepUpload || Boolean(options.remoteFileName);
      await report(progress, {
        kind: "stage",
        stage: "uploading_to_gemini",
        message: options.remoteFileName
          ? "Reusing the retained Gemini upload…"
          : "Uploading recording to Gemini Files API…",
      });
      assertNotCanceled(execution.signal);
      let remote: GeminiFile;
      try {
        remote = await tracer.span({
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
            return analyzer.resolveRetainedFile(
              options.remoteFileName,
              recordingSha256,
              recordingSizeBytes,
            );
          }
          return analyzer.upload(localVideo, mimeType);
        });
      } catch (error) {
        if (error instanceof AnalysisCanceledError) throw error;
        assertNotCanceled(execution.signal);
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
          schemaVersion: 1,
          toolVersion: "0.3.0",
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
          model: analyzer.model,
          recordingSha256,
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
        const index = await tracer.span({
          op: "gen_ai.chat",
          name: "gemini index",
          attributes: chatAttributes,
        }, async (span) => {
          const usageBefore = usageCountsOf(analyzer);
          const indexed = await analyzer.index(
            remote,
            meeting,
            options.recipe,
            options.focus,
            indexFps,
            derivedTranscript,
          );
          span.setAttributes({
            ...usageDeltaAttributes(usageBefore, usageCountsOf(analyzer)),
            "frame_of_mind.candidates_indexed": indexed.moments.length,
          });
          return indexed;
        });
        assertNotCanceled(execution.signal);
        let alignment: RunManifest["transcriptAlignment"] | undefined;
        if (hasContext) {
          if (!isMeetingAnalysisIndex(index)) {
            throw new Error("Gemini meeting analysis omitted transcript alignment metadata.");
          }
          if (!index.isRelevantCall) {
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
              ? {
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
        const providerTranscript = meeting?.transcript?.trim() ? meeting.transcript : undefined;
        const effectiveTranscript = providerTranscript ?? derivedTranscript;
        const transcriptIsDerived = Boolean(derivedTranscript) && !providerTranscript;
        const items: AnalysisItem[] = [];
        const failures: CandidateFailure[] = [];
        const candidates = index.moments.slice(0, options.maxIncidents);
        failurePhase = "detail";
        await report(progress, {
          kind: "stage",
          stage: "interrogating",
          message: "Pass 2/2: interrogating indexed candidates…",
        });
        for (const [indexNumber, candidate] of candidates.entries()) {
          assertNotCanceled(execution.signal);
          try {
            const result = await tracer.span({
              op: "gen_ai.chat",
              name: "gemini interrogate",
              attributes: {
                ...chatAttributes,
                "frame_of_mind.candidate_ordinal": indexNumber + 1,
              },
            }, async (span) => {
              const usageBefore = usageCountsOf(analyzer);
              const detail = await analyzer.interrogate(
                remote,
                candidate,
                effectiveTranscript && (alignment || transcriptIsDerived)
                  ? nearbyTranscript(
                      effectiveTranscript,
                      candidate.start,
                      candidate.end,
                      45,
                      transcriptIsDerived ? 0 : alignment?.offsetSeconds ?? 0,
                    )
                  : undefined,
                options.recipe,
                options.focus,
                transcriptIsDerived,
              );
              span.setAttributes({
                ...usageDeltaAttributes(usageBefore, usageCountsOf(analyzer)),
                "frame_of_mind.candidate_accepted": detail.accepted,
              });
              return detail;
            });
            assertNotCanceled(execution.signal);
            assertEvidenceWithinCandidate(
              result.evidence?.timestamp,
              candidate.start,
              candidate.end,
            );
            const item: AnalysisItem = { candidate, result };
            if (options.screenshots && result.accepted) {
              const screenshotName = `moment-${String(indexNumber + 1).padStart(2, "0")}.png`;
              const screenshotPath = join(stagingDirectory, screenshotName);
              if (await this.screenshot(localVideo, result.evidence?.timestamp || candidate.start, screenshotPath)) {
                item.screenshot = screenshotName;
              }
              assertNotCanceled(execution.signal);
            }
            items.push(item);
          } catch (error) {
            if (error instanceof AnalysisCanceledError) throw error;
            if (!(error instanceof CandidateAnalysisError)) throw error;
            failures.push({
              candidateOrdinal: indexNumber + 1,
              start: candidate.start,
              end: candidate.end,
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
            message: `Pass 2/2 [${indexNumber + 1}/${candidates.length}] at ${candidate.start}`,
          });
        }

        const omittedByLimit = index.moments.length - candidates.length;
        if (omittedByLimit > 0) {
          await reportWarning(progress, {
            kind: "warning",
            stage: "interrogating",
            message:
              `Analysis truncated: ${omittedByLimit} indexed candidate(s) were not interrogated because of the configured moment limit (${options.maxIncidents}). Coverage stops early; rerun with a higher --max-moments to analyze the full recording.`,
          });
        }
        const outcome = analysisOutcomeSchema.parse({
          schemaVersion: 1,
          runId,
          status: failures.length > 0 && items.length === 0
            ? "failed"
            : failures.length > 0 || omittedByLimit > 0
              ? "partial"
              : "complete",
          candidates: {
            indexed: index.moments.length,
            selected: candidates.length,
            omittedByLimit,
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
              schemaVersion: 2,
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
              model: analyzer.model,
              matchNotes: index.matchNotes,
              items,
            }
          : {
              schemaVersion: 3,
              runId,
              recipe: {
                id: options.recipe.id,
                label: options.recipe.label,
              },
              context: { mode: "none" },
              model: analyzer.model,
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
        failurePhase = "cleanup";
        await report(progress, {
          kind: "stage",
          stage: "cleaning_up",
          message: retainRemote ? "Finalizing the analysis bundle." : "Deleting the temporary Gemini upload.",
        });
        if (!retainRemote) {
          remoteDeleted = await deleteWithRetry(analyzer, remote, this.sleep);
          cleanupFinalized = remoteDeleted;
        }
        failurePhase = "render";
        const analysisSha256 = await analysisDigest(analysis);
        const promptProvenance = {
          indexPrefixSha256: await sha256Utf8(promptPrefix(options.recipe, "index")),
          interrogationPrefixSha256: await sha256Utf8(promptPrefix(options.recipe, "detail")),
          modelRouting: {
            requestedModel: analyzer.model,
            // GEMINI_MODEL set to the default value is still an explicit
            // choice; only env-absent default-model runs report default-flash.
            reason: options.model
              ? "operator-selected" as const
              : process.env.GEMINI_MODEL || analyzer.model !== DEFAULT_GEMINI_MODEL
                ? "environment-or-dependency-override" as const
                : "default-flash" as const,
          },
        };
        const manifestBase = {
          toolVersion: "0.3.0",
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
          model: analyzer.model,
          recordingSha256,
          analysisSha256,
          recordingMimeType: mimeType,
          remoteFile: {
            ...sanitizedRemoteFileMetadata(remote),
            deleted: remoteDeleted,
          },
          analysis: {
            ...(options.focus ? { focus: options.focus } : {}),
            maxIncidents: options.maxIncidents,
            indexFps,
            indexResolution: "low" as const,
            interrogationResolution: "medium" as const,
          },
          ...(derivedTranscriptProvenance
            ? { derivedTranscript: derivedTranscriptProvenance }
            : {}),
          promptProvenance,
          artifacts: [
            "analysis.json",
            "analysis-outcome.json",
            "analysis.md",
            "report.html",
            "manifest.json",
            ...items.flatMap((item) => (item.screenshot ? [item.screenshot] : [])),
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
          );
          assertNotCanceled(execution.signal);
          await rename(stagingDirectory!, outputDirectory);
        });
        stagingDirectory = undefined;
        // Once the bundle is published its cleanup state must remain immutable.
        // Failed cleanup may be retried in `finally` only while publication has
        // not completed and no durable manifest exists.
        cleanupFinalized = true;
        if (!retainRemote && !remoteDeleted) {
          await reportWarning(progress, {
            kind: "warning",
            stage: "cleaning_up",
            message: "Gemini file cleanup failed; manifest records deleted=false.",
          });
        }
        const published: PublishedAnalysisRun = isRunImportV2(validated)
          ? {
              directory: outputDirectory,
              analysis: validated.analysis,
              manifest: validated.manifest,
              outcome,
            }
          : isRunImportV3(validated)
            ? {
                directory: outputDirectory,
                analysis: validated.analysis,
                manifest: validated.manifest,
                outcome,
              }
            : (() => {
                throw new Error("Run contract schema versions do not match.");
              })();
        let projectionWarning: string | undefined;
        if (execution.projection) {
          try {
            await execution.projection.publish(
              structuredClone(projectionInputFrom(published)),
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
          ...(projectionWarning ? { projectionWarning } : {}),
        };
      } catch (error) {
        if (error instanceof AnalysisCanceledError) throw error;
        if (!retainRemote && !cleanupFinalized) {
          remoteDeleted = await deleteWithRetry(analyzer, remote, this.sleep);
          cleanupFinalized = true;
        }
        const failure = runFailureManifestSchema.parse({
          schemaVersion: 1,
          toolVersion: "0.3.0",
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
          model: analyzer.model,
          recordingSha256,
          error: sanitizedFailureError(error),
          remoteFile: {
            ...sanitizedRemoteFileMetadata(remote),
            cleanup: retainRemote
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
          } catch {
            await reportWarning(progress, {
              kind: "warning",
              stage: "cleaning_up",
              message: "The sanitized failure manifest could not be published.",
            });
          }
        }
        if (!retainRemote && !remoteDeleted) {
          await reportUnconfirmedCleanup(
            progress,
            sanitizedRemoteFileMetadata(remote).name,
          );
        }
        throw error;
      } finally {
        if (!retainRemote && !cleanupFinalized) {
          const deleted = await deleteWithRetry(analyzer, remote, this.sleep);
          if (!deleted) {
            await reportWarning(progress, {
              kind: "warning",
              stage: "cleaning_up",
              message: "Gemini file cleanup did not complete after analysis failure.",
            });
          }
        }
      }
    } finally {
      await context?.close().catch(() => undefined);
      if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
      if (runContainerDirectory) await rmdir(runContainerDirectory).catch(() => undefined);
      await rm(temp, { recursive: true, force: true });
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
    createAnalyzer: (apiKey, analyzeOptions) =>
      new GeminiVideoAnalyzer(apiKey, analyzeOptions.model),
  });
}

function defaultCreateContextSource(options: ContextEnrichedAnalyzeOptions): MeetingContextSource {
  const interactive = options.interactiveProviderAuth ?? true;
  if (options.contextProvider === "bluedot") {
    return new BluedotClient(undefined, interactive, interactive);
  }
  if (options.contextProvider === "granola") {
    return options.granolaTransport === "api"
      ? new GranolaApiClient(options.granolaApiKey)
      : new GranolaClient(undefined, interactive, interactive);
  }
  if (!options.contextFile) throw new Error("--context-file is required when --source file is selected.");
  return new FileContextSource(options.contextFile);
}

async function deleteWithRetry(
  analyzer: AnalysisVideoAnalyzer,
  remote: GeminiFile,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await analyzer.delete(remote);
      return true;
    } catch {
      if (attempt < 2) await sleep(500 * (attempt + 1));
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
  return { code: "unexpected_failure" };
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

function usageCountsOf(analyzer: AnalysisVideoAnalyzer): TracedUsageCounts | undefined {
  return typeof analyzer.usageSnapshot === "function" ? analyzer.usageSnapshot() : undefined;
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

function projectionInputFrom(
  published: PublishedAnalysisRun,
): AnalysisProjectionInput {
  if (
    published.analysis.schemaVersion === 2
    && published.manifest.schemaVersion === 2
  ) {
    return {
      analysis: published.analysis,
      manifest: published.manifest,
      outcome: published.outcome,
    };
  }
  if (
    published.analysis.schemaVersion === 3
    && published.manifest.schemaVersion === 3
  ) {
    return {
      analysis: published.analysis,
      manifest: published.manifest,
      outcome: published.outcome,
    };
  }
  throw new Error("Run contract schema versions do not match.");
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
