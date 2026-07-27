import { mkdtemp, rename, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { File as GeminiFile } from "@google/genai";
import type {
  AnalysisDetail,
  AnalysisRecipe,
  AnalysisRun,
  AnalysisItem,
  ContextProvider,
  IndexedMoment,
  MeetingContextSource,
  MeetingEvidence,
  MediaSource,
  RunManifest,
} from "../domain/types.js";
import { runImportSchema } from "../domain/schemas.js";
import { analysisDigest } from "../domain/integrity.js";
import { BluedotClient } from "../adapters/bluedot-mcp.js";
import { GranolaClient } from "../adapters/granola-mcp.js";
import { GranolaApiClient } from "../adapters/granola-api.js";
import { FileContextSource } from "../adapters/file-context.js";
import { GeminiVideoAnalyzer } from "../adapters/gemini.js";
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
import { nearbyTranscript } from "./transcript.js";
import { extractScreenshot } from "./screenshots.js";
import { writeArtifacts } from "./artifacts.js";
import { timestampToSeconds } from "../lib/time.js";

export interface AnalyzeOptions {
  meetingId: string;
  recipe: AnalysisRecipe;
  customRecipe: boolean;
  recipeSha256: string;
  recipeRevision: string;
  contextProvider: ContextProvider;
  granolaTransport: "mcp" | "api";
  granolaApiKey?: string;
  interactiveProviderAuth?: boolean;
  contextFile?: string;
  apiKey: string;
  model?: string;
  video?: string;
  expectedVideoSha256?: string;
  recordingUrl?: string;
  focus?: string;
  outputRoot: string;
  maxIncidents: number;
  screenshots: boolean;
  keepUpload: boolean;
  transcriptOffsetSeconds?: number;
}

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

export interface PublishedAnalysisRun {
  readonly directory: string;
  readonly analysis: AnalysisRun;
  readonly manifest: RunManifest;
}

export type AnalysisProjectionInput = Omit<PublishedAnalysisRun, "directory">;

export interface AnalysisProjectionPublisher {
  publish(run: AnalysisProjectionInput): Promise<void>;
}

export interface AnalyzeExecutionOptions {
  signal?: AbortSignal;
  progress?: AnalysisProgressReporter;
  projection?: AnalysisProjectionPublisher;
}

interface AnalysisIndex {
  isRelevantCall: boolean;
  matchNotes: string;
  transcriptAlignment: {
    offsetSeconds: number;
    confidence: "high" | "medium" | "low" | "none";
    rationale: string;
  };
  moments: IndexedMoment[];
}

export interface AnalysisVideoAnalyzer {
  readonly model: string;
  upload(path: string, mimeType: string): Promise<GeminiFile>;
  index(file: GeminiFile, meeting: MeetingEvidence, recipe: AnalysisRecipe, focus?: string): Promise<AnalysisIndex>;
  interrogate(
    file: GeminiFile,
    candidate: IndexedMoment,
    nearbyTranscript: string,
    recipe: AnalysisRecipe,
    focus?: string,
  ): Promise<AnalysisDetail>;
  delete(file: GeminiFile): Promise<void>;
}

interface BluedotMediaContextSource extends MeetingContextSource {
  mediaFromMeeting(meeting: MeetingEvidence, overrideUrl?: string): MediaSource;
}

export interface AnalysisOrchestratorDependencies {
  createContextSource(options: AnalyzeOptions): MeetingContextSource;
  createAnalyzer(
    apiKey: string,
    options: AnalyzeOptions,
  ): AnalysisVideoAnalyzer;
  createRunId?: () => string;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  extractScreenshot?: typeof extractScreenshot;
}

export interface AnalyzeResult extends PublishedAnalysisRun {
  projectionWarning?: string;
}

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

  constructor(dependencies: AnalysisOrchestratorDependencies) {
    this.createContextSource = dependencies.createContextSource;
    this.createAnalyzer = dependencies.createAnalyzer;
    this.nextRunId = dependencies.createRunId ?? createRunId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.screenshot = dependencies.extractScreenshot ?? extractScreenshot;
  }

  async analyze(options: AnalyzeOptions, execution: AnalyzeExecutionOptions = {}): Promise<AnalyzeResult> {
    const runId = requireSafeRunId(this.nextRunId());
    const startedAt = this.now();
    const context = this.createContextSource(options);
    const progress = execution.progress ?? NOOP_PROGRESS_REPORTER;
    const temp = await mkdtemp(join(tmpdir(), "frame-of-mind-"));
    let meeting: MeetingEvidence = {
      id: options.meetingId,
      provider: options.contextProvider,
      transport: options.contextProvider === "file" ? "file" : "mcp",
      transcript: "",
      raw: {},
    };
    let localVideo = options.video ? resolve(options.video) : "";
    let downloadedMimeType: string | undefined;
    let mediaSource: RunManifest["mediaSource"] = "local-file";
    let stagingDirectory: string | undefined;
    let meetingDirectory: string | undefined;

    try {
      assertNotCanceled(execution.signal);
      await report(progress, {
        kind: "stage",
        stage: "fetching_context",
        message: "Fetching meeting context.",
      });
      await context.connect();
      assertNotCanceled(execution.signal);
      meeting = await context.meeting(options.meetingId);
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

      const mimeType = mimeForPath(localVideo, downloadedMimeType);
      if (!mimeType.startsWith("video/")) {
        throw new Error(
          `Frame of Mind requires a screen recording; received '${mimeType}'. ` +
            "Audio-only calls have no visual UI evidence to interrogate.",
        );
      }
      if ((await stat(localVideo)).size > MAX_RECORDING_BYTES) {
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
      meetingDirectory = join(resolve(options.outputRoot), safePathSegment(meeting.id));
      const outputDirectory = join(meetingDirectory, runId);
      stagingDirectory = join(meetingDirectory, `.${runId}.staging`);
      await ensureDirectory(meetingDirectory);
      await ensureDirectory(stagingDirectory);

      const analyzer = this.createAnalyzer(options.apiKey, options);
      if (options.model && analyzer.model !== options.model) {
        throw new Error(
          "Resolved Gemini analyzer does not match the requested model.",
        );
      }
      await report(progress, {
        kind: "stage",
        stage: "uploading_to_gemini",
        message: "Uploading recording to Gemini Files API…",
      });
      assertNotCanceled(execution.signal);
      const remote = await analyzer.upload(localVideo, mimeType);
      let remoteDeleted = false;
      let cleanupFinalized = options.keepUpload;
      try {
        assertNotCanceled(execution.signal);
        await report(progress, {
          kind: "stage",
          stage: "indexing",
          message: "Pass 1/2: indexing the whole recording…",
        });
        assertNotCanceled(execution.signal);
        const index = await analyzer.index(remote, meeting, options.recipe, options.focus);
        assertNotCanceled(execution.signal);
        if (!index.isRelevantCall) {
          throw new Error(
            "Recording/transcript mismatch. Verify that the provider meeting ID and local recording refer to the same call.",
          );
        }
        const alignment =
          options.transcriptOffsetSeconds === undefined
            ? {
                offsetSeconds: index.transcriptAlignment.offsetSeconds,
                method: index.transcriptAlignment.confidence === "none" ? ("none" as const) : ("model" as const),
                confidence: index.transcriptAlignment.confidence,
                rationale: index.transcriptAlignment.rationale,
              }
            : {
                offsetSeconds: options.transcriptOffsetSeconds,
                method: "explicit" as const,
                confidence: "high" as const,
                rationale: "Operator supplied --transcript-offset.",
              };
        const items: AnalysisItem[] = [];
        const candidates = index.moments.slice(0, options.maxIncidents);
        await report(progress, {
          kind: "stage",
          stage: "interrogating",
          message: "Pass 2/2: interrogating indexed candidates…",
        });
        for (const [indexNumber, candidate] of candidates.entries()) {
          assertNotCanceled(execution.signal);
          const result = await analyzer.interrogate(
            remote,
            candidate,
            nearbyTranscript(meeting.transcript, candidate.start, candidate.end, 45, alignment.offsetSeconds),
            options.recipe,
            options.focus,
          );
          assertNotCanceled(execution.signal);
          assertEvidenceWithinCandidate(result.evidence?.timestamp, candidate.start, candidate.end);
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

        const analysis: AnalysisRun = {
          schemaVersion: 2,
          runId,
          recipe: {
            id: options.recipe.id,
            label: options.recipe.label,
          },
          meeting: {
            id: meeting.id,
            provider: meeting.provider,
            ...(meeting.title ? { title: meeting.title } : {}),
            ...(meeting.createdAt ? { createdAt: meeting.createdAt } : {}),
            ...(meeting.sourceUrl ? { sourceUrl: meeting.sourceUrl } : {}),
          },
          model: analyzer.model,
          matchNotes: index.matchNotes,
          items,
        };
        await report(progress, {
          kind: "stage",
          stage: "rendering",
          message: "Validating and rendering the analysis bundle.",
        });
        assertNotCanceled(execution.signal);
        await report(progress, {
          kind: "stage",
          stage: "cleaning_up",
          message: options.keepUpload ? "Finalizing the analysis bundle." : "Deleting the temporary Gemini upload.",
        });
        if (!options.keepUpload) {
          remoteDeleted = await deleteWithRetry(analyzer, remote, this.sleep);
          cleanupFinalized = remoteDeleted;
        }
        const analysisSha256 = await analysisDigest(analysis);
        const manifest: RunManifest = {
          schemaVersion: 2,
          toolVersion: "0.2.1",
          promptRevision: "2026-07-27.2",
          runId,
          startedAt,
          completedAt: this.now(),
          meetingId: meeting.id,
          recipe: {
            id: options.recipe.id,
            label: options.recipe.label,
            custom: options.customRecipe,
            revision: options.recipeRevision,
            sha256: options.recipeSha256,
          },
          model: analyzer.model,
          recordingSha256,
          transcriptSha256: sha256Text(meeting.transcript),
          analysisSha256,
          recordingMimeType: mimeType,
          contextProvider: meeting.provider,
          contextTransport: meeting.transport,
          mediaSource,
          transcriptAlignment: alignment,
          remoteFile: {
            ...(remote.name ? { name: remote.name } : {}),
            ...(remote.expirationTime ? { expirationTime: remote.expirationTime } : {}),
            deleted: remoteDeleted,
          },
          analysis: {
            ...(options.focus ? { focus: options.focus } : {}),
            maxIncidents: options.maxIncidents,
            indexFps: 0.5,
            indexResolution: "low",
            interrogationResolution: "medium",
          },
          artifacts: [
            "analysis.json",
            "analysis.md",
            "report.html",
            "manifest.json",
            ...items.flatMap((item) => (item.screenshot ? [item.screenshot] : [])),
          ],
        };
        const validated = runImportSchema.parse({ analysis, manifest });
        assertNotCanceled(execution.signal);
        await writeArtifacts(stagingDirectory, validated.analysis, validated.manifest);
        assertNotCanceled(execution.signal);
        await rename(stagingDirectory, outputDirectory);
        stagingDirectory = undefined;
        // Once the bundle is published its cleanup state must remain immutable.
        // Failed cleanup may be retried in `finally` only while publication has
        // not completed and no durable manifest exists.
        cleanupFinalized = true;
        if (!options.keepUpload && !remoteDeleted) {
          await reportWarning(progress, {
            kind: "warning",
            stage: "cleaning_up",
            message: "Gemini file cleanup failed; manifest records deleted=false.",
          });
        }
        const published: PublishedAnalysisRun = {
          directory: outputDirectory,
          analysis: validated.analysis,
          manifest: validated.manifest,
        };
        let projectionWarning: string | undefined;
        if (execution.projection) {
          try {
            await execution.projection.publish(structuredClone({
              analysis: published.analysis,
              manifest: published.manifest,
            }));
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
      } finally {
        if (!options.keepUpload && !cleanupFinalized) {
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
      await context.close().catch(() => undefined);
      if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
      if (meetingDirectory) await rmdir(meetingDirectory).catch(() => undefined);
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

function defaultCreateContextSource(options: AnalyzeOptions): MeetingContextSource {
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

function isBluedotMediaContextSource(context: MeetingContextSource): context is BluedotMediaContextSource {
  return "mediaFromMeeting" in context && typeof context.mediaFromMeeting === "function";
}

export function assertEvidenceWithinCandidate(
  evidenceTimestamp: string | undefined,
  candidateStart: string,
  candidateEnd: string,
): void {
  if (!evidenceTimestamp) return;
  const evidence = timestampToSeconds(evidenceTimestamp);
  if (evidence < timestampToSeconds(candidateStart) || evidence > timestampToSeconds(candidateEnd)) {
    throw new Error("Gemini returned an evidence timestamp outside the indexed candidate window.");
  }
}
