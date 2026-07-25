import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { File as GeminiFile } from "@google/genai";
import type {
  AnalysisRecipe,
  AnalysisRun,
  AnalysisItem,
  ContextProvider,
  MeetingContextSource,
  MeetingEvidence,
  RunManifest,
} from "../domain/types.js";
import { BluedotClient } from "../adapters/bluedot-mcp.js";
import { GranolaClient } from "../adapters/granola-mcp.js";
import { GranolaApiClient } from "../adapters/granola-api.js";
import { FileContextSource } from "../adapters/file-context.js";
import { GeminiVideoAnalyzer } from "../adapters/gemini.js";
import {
  createRunId,
  downloadFile,
  ensureDirectory,
  mimeForPath,
  sha256File,
  sha256Text,
} from "../lib/files.js";
import { nearbyTranscript } from "./transcript.js";
import { extractScreenshot } from "./screenshots.js";
import { writeArtifacts } from "./artifacts.js";

export interface AnalyzeOptions {
  meetingId: string;
  recipe: AnalysisRecipe;
  customRecipe: boolean;
  contextProvider: ContextProvider;
  granolaTransport: "mcp" | "api";
  contextFile?: string;
  apiKey: string;
  video?: string;
  recordingUrl?: string;
  focus?: string;
  outputRoot: string;
  maxIncidents: number;
  screenshots: boolean;
  keepUpload: boolean;
  transcriptOffsetSeconds?: number;
}

export async function analyzeMeeting(options: AnalyzeOptions): Promise<{ directory: string; analysis: AnalysisRun }> {
  const runId = createRunId();
  const startedAt = new Date().toISOString();
  const temp = await mkdtemp(join(tmpdir(), "frame-of-mind-"));
  const context = createContextSource(options);
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

  try {
    await context.connect();
    meeting = await context.meeting(options.meetingId);
    if (!localVideo) {
      if (options.contextProvider !== "bluedot") {
        throw new Error(
          `${options.contextProvider} supplies meeting context, not a screen recording. ` +
          "Provide --video with a local recording.",
        );
      }
      const media = (context as BluedotClient).mediaFromMeeting(meeting, options.recordingUrl);
      const extension = new URL(media.url).pathname.match(/\.(webm|mp4|m4v|mov|mp3)$/i)?.[0] || ".webm";
      localVideo = join(temp, `recording${extension}`);
      const download = await downloadFile(media.url, localVideo);
      downloadedMimeType = download.mimeType;
      mediaSource = media.source === "mcp" ? "bluedot-mcp" : "signed-url";
      process.stderr.write(`Downloaded ${(download.bytes / 1_000_000).toFixed(1)} MB recording.\n`);
    }

    const mimeType = mimeForPath(localVideo, downloadedMimeType);
    if (!mimeType.startsWith("video/")) {
      throw new Error(
        `Frame of Mind requires a screen recording; received '${mimeType}'. ` +
        "Audio-only calls have no visual UI evidence to interrogate.",
      );
    }
    const recordingSha256 = await sha256File(localVideo);
    const meetingDirectory = join(resolve(options.outputRoot), safeName(meeting.id));
    const outputDirectory = join(meetingDirectory, runId);
    stagingDirectory = join(meetingDirectory, `.${runId}.staging`);
    await ensureDirectory(meetingDirectory);
    await ensureDirectory(stagingDirectory);

    const analyzer = new GeminiVideoAnalyzer(options.apiKey);
    process.stderr.write(`Uploading ${basename(localVideo)} to Gemini Files API…\n`);
    const remote = await analyzer.upload(localVideo, mimeType);
    let remoteDeleted = false;
    let cleanupFinalized = options.keepUpload;
    try {
      process.stderr.write("Pass 1/2: indexing the whole recording…\n");
      const index = await analyzer.index(remote, meeting, options.recipe, options.focus);
      if (!index.isRelevantCall) {
        throw new Error(`Recording/transcript mismatch: ${singleLine(index.matchNotes)}`);
      }
      const alignment = options.transcriptOffsetSeconds === undefined
        ? {
            offsetSeconds: index.transcriptAlignment.offsetSeconds,
            method: index.transcriptAlignment.confidence === "none" ? "none" as const : "model" as const,
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
      for (const [indexNumber, candidate] of candidates.entries()) {
        process.stderr.write(
          `Pass 2/2 [${indexNumber + 1}/${candidates.length}] at ${safeTimestamp(candidate.start)}\n`,
        );
        const result = await analyzer.interrogate(
          remote,
          candidate,
          nearbyTranscript(
            meeting.transcript,
            candidate.start,
            candidate.end,
            45,
            alignment.offsetSeconds,
          ),
          options.recipe,
          options.focus,
        );
        const item: AnalysisItem = { candidate, result };
        if (options.screenshots && result.accepted) {
          const screenshotName = `moment-${String(indexNumber + 1).padStart(2, "0")}.png`;
          const screenshotPath = join(stagingDirectory, screenshotName);
          if (await extractScreenshot(localVideo, result.evidence?.timestamp || candidate.start, screenshotPath)) {
            item.screenshot = screenshotName;
          }
        }
        items.push(item);
      }

      const analysis: AnalysisRun = {
        schemaVersion: 1,
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
      if (!options.keepUpload) {
        remoteDeleted = await deleteWithRetry(analyzer, remote);
        cleanupFinalized = true;
      }
      const manifest: RunManifest = {
        schemaVersion: 1,
        toolVersion: "0.1.0",
        promptRevision: "2026-07-25.1",
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        meetingId: meeting.id,
        recipe: {
          id: options.recipe.id,
          label: options.recipe.label,
          custom: options.customRecipe,
        },
        model: analyzer.model,
        recordingSha256,
        transcriptSha256: sha256Text(meeting.transcript),
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
          ...items.flatMap((item) => item.screenshot ? [item.screenshot] : []),
        ],
      };
      await writeArtifacts(stagingDirectory, analysis, manifest);
      await rename(stagingDirectory, outputDirectory);
      stagingDirectory = undefined;
      if (!options.keepUpload && !remoteDeleted) {
        process.stderr.write("Warning: Gemini file cleanup failed; manifest records deleted=false.\n");
      }
      return { directory: outputDirectory, analysis };
    } finally {
      if (!options.keepUpload && !cleanupFinalized) {
        const deleted = await deleteWithRetry(analyzer, remote);
        if (!deleted) process.stderr.write("Warning: Gemini file cleanup did not complete after analysis failure.\n");
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
}

function createContextSource(options: AnalyzeOptions): MeetingContextSource {
  if (options.contextProvider === "bluedot") return new BluedotClient();
  if (options.contextProvider === "granola") {
    return options.granolaTransport === "api" ? new GranolaApiClient() : new GranolaClient();
  }
  if (!options.contextFile) throw new Error("--context-file is required when --source file is selected.");
  return new FileContextSource(options.contextFile);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "meeting";
}

function safeTimestamp(value: string): string {
  return value.replace(/[^\d:.-]/g, "").slice(0, 16) || "unknown time";
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").slice(0, 500);
}

async function deleteWithRetry(analyzer: GeminiVideoAnalyzer, remote: GeminiFile): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await analyzer.delete(remote);
      return true;
    } catch {
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}
