import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { File as GeminiFile } from "@google/genai";
import { GeminiVideoAnalyzer } from "../adapters/gemini.js";
import { GeminiFileError } from "../adapters/gemini-files.js";
import { DEFAULT_GEMINI_MODEL, geminiModelSchema } from "../adapters/gemini-model.js";
import { resolveRetention, type RetentionFlags } from "../domain/retention.js";
import type { DerivedTranscriptionSegment } from "../domain/types.js";
import { sha256File } from "../lib/files.js";
import { extractAudioTrack, planTranscriptionWindows, probeDurationSeconds } from "./audio.js";
import { mergeTranscriptionChunks, offsetTranscriptionSegments } from "./transcript.js";
import { TRANSCRIPTION_OVERLAP_SECONDS, TRANSCRIPTION_WINDOW_SECONDS } from "./transcription-policy.js";
import { assertTranscriptTarget, renderSpeakers, renderSrt, renderTranscriptJson, writePrivateAtomic } from "./transcript-render.js";

export class TranscribeError extends Error {}
export class TranscribeCanceledError extends TranscribeError {
  constructor() { super("Transcription canceled; no transcript files written."); }
}
export interface TranscribeOptions extends RetentionFlags {
  input: string;
  output?: string;
  model?: string;
  json?: boolean;
  force?: boolean;
  apiKey?: string;
  signal?: AbortSignal;
}
export interface TranscriptionAnalyzer {
  readonly model: string;
  upload(path: string, mimeType: string): Promise<GeminiFile>;
  transcribe(file: GeminiFile): Promise<DerivedTranscriptionSegment[]>;
  delete(file: GeminiFile): Promise<void>;
  usageSnapshot?(): { promptTokens: number; outputTokens: number; totalTokens: number } | undefined;
}
export interface TranscribeDependencies {
  createAnalyzer: (apiKey: string, model: string) => TranscriptionAnalyzer;
  extractAudioTrack: typeof extractAudioTrack;
  probeDurationSeconds: typeof probeDurationSeconds;
  sleep: (milliseconds: number) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now: () => string;
}

function uploadLabel(remote: GeminiFile): string {
  const name = remote.name && /^files\/[a-zA-Z0-9_-]+$/.test(remote.name) ? remote.name : "unknown";
  const expiry = remote.expirationTime && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(remote.expirationTime)
    && Number.isFinite(Date.parse(remote.expirationTime)) ? remote.expirationTime : "unknown";
  return `${name}; expiry: ${expiry}`;
}

/** Adopted standalone transcription workflow. It never creates an analysis run bundle. */
export async function transcribe(options: TranscribeOptions, injected: Partial<TranscribeDependencies> = {}) {
  const deps: TranscribeDependencies = {
    createAnalyzer: (key, model) => new GeminiVideoAnalyzer(key, model),
    extractAudioTrack, probeDurationSeconds,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    stdout: line => { process.stdout.write(`${line}\n`); },
    stderr: line => { process.stderr.write(`${line}\n`); },
    now: () => new Date().toISOString(), ...injected,
  };
  const canceled = () => { if (options.signal?.aborted) throw new TranscribeCanceledError(); };
  const model = options.model ?? (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
  if (!geminiModelSchema.safeParse(model).success) throw new TranscribeError("--model must be a Gemini model ID.");
  let retention;
  try { retention = resolveRetention(options, process.env.FRAME_OF_MIND_UPLOAD_RETENTION); }
  catch { throw new TranscribeError("Upload retention flags must agree and select provider or run."); }
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new TranscribeError("Set GEMINI_API_KEY before transcription.");
  canceled();
  const input = resolve(options.input);
  const output = resolve(options.output ?? dirname(input));
  const stem = basename(input, extname(input));
  const paths = [join(output, `${stem}.srt`), join(output, `${stem}_speakers.txt`),
    ...(options.json ? [join(output, `${stem}.transcript.json`)] : [])];
  try {
    const original = await stat(input);
    if (!original.isFile()) throw new Error("not a file");
    for (const path of paths) {
      await assertTranscriptTarget(path, options.force);
      const target = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (path === input || (target && target.dev === original.dev && target.ino === original.ino)) {
        throw new TranscribeError("A transcript target would replace the input recording; choose another output directory.");
      }
    }
  } catch (error) {
    if (error instanceof TranscribeError) throw error;
    throw new TranscribeError("Check the input file and output targets; existing targets require --force. See docs/RUNBOOK.md §3.11.");
  }
  const duration = await deps.probeDurationSeconds(input);
  canceled();
  if (duration === undefined) throw new TranscribeError("Cannot read recording duration. Check ffprobe and the input file; see docs/RUNBOOK.md §6.20.");
  const windows = planTranscriptionWindows(duration, TRANSCRIPTION_WINDOW_SECONDS, TRANSCRIPTION_OVERLAP_SECONDS);
  const analyzer = deps.createAnalyzer(apiKey, model);
  deps.stdout(`model: ${model}; duration: ${Math.round(duration)} s; windows: ${windows.length}; retention: ${retention}; upload limit: 2 GB`);
  const temp = await mkdtemp(join(tmpdir(), "fom-transcribe-"));
  const chunks: Array<{ segments: DerivedTranscriptionSegment[]; nominalStartSeconds: number }> = [];
  try {
    for (const [index, window] of windows.entries()) {
      canceled();
      const audioPath = join(temp, `audio-${index + 1}.aac`);
      try {
        if (!(await deps.extractAudioTrack(input, audioPath, {
          ...(window.startSeconds ? { startSeconds: window.startSeconds } : {}),
          durationSeconds: window.durationSeconds,
        }))) throw new TranscribeError("No audio track could be extracted. Check ffmpeg and the recording's audio; see docs/RUNBOOK.md §6.20.");
        canceled();
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          canceled();
          let remote: GeminiFile | undefined;
          try {
            remote = await analyzer.upload(audioPath, "audio/aac");
            if (retention === "provider") deps.stderr(`kept audio upload: ${uploadLabel(remote)}`);
            const segments = await analyzer.transcribe(remote);
            chunks.push({ segments: offsetTranscriptionSegments(segments, window.startSeconds), nominalStartSeconds: window.nominalStartSeconds });
            deps.stdout(`window ${index + 1}/${windows.length}: ${segments.length} segment(s)`);
            break;
          } catch (error) {
            if (error instanceof GeminiFileError && error.uploadCleanup === "unconfirmed") {
              deps.stderr("warning: failed audio upload cleanup is unconfirmed; provider expiry applies.");
            }
            canceled();
            if (attempt === 2) throw new TranscribeError(`Transcription failed on window ${index + 1} after 2 attempts; no transcript files written.`);
            deps.stderr(`window ${index + 1}: retrying once after 20 s`);
          } finally {
            if (remote && retention === "run") {
              try { await analyzer.delete(remote); }
              catch { deps.stderr(`warning: audio upload deletion unconfirmed: ${uploadLabel(remote)}`); }
            }
          }
          await deps.sleep(20_000);
        }
      } finally { await rm(audioPath, { force: true }); }
      canceled();
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
  canceled();
  const segments = mergeTranscriptionChunks(chunks);
  const provenance = { model, clock: "source" as const, recordingSha256: await sha256File(input), createdAt: deps.now() };
  const srt = renderSrt(segments);
  const texts = [srt.text, renderSpeakers(segments, provenance), ...(options.json ? [renderTranscriptJson(segments, provenance)] : [])];
  canceled();
  await mkdir(output, { recursive: true, mode: 0o700 });
  // Each file is published atomically only after all windows and rendering succeed.
  for (const [index, path] of paths.entries()) {
    await writePrivateAtomic(path, texts[index]!, { force: options.force });
    deps.stdout(`wrote: ${path}; clock: source`);
  }
  deps.stdout(`segments: ${segments.length}; speakers: ${new Set(segments.map(s => s.speaker)).size}; adjustedCues: ${srt.adjustedCues}; blankCues: ${srt.blankCues}`);
  const usage = analyzer.usageSnapshot?.();
  if (usage) deps.stdout(`tokens: ${JSON.stringify(usage)}`);
  return { segments, paths, adjustedCues: srt.adjustedCues, blankCues: srt.blankCues };
}
