import { applicationSetting } from "../lib/application-settings.js";
import { faultCode, type FaultCode } from "../domain/contract-error.js";
import { createScratch } from "../adapters/scratch.js";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { File as GeminiFile } from "@google/genai";
import { GeminiVideoAnalyzer } from "../adapters/gemini.js";
import { providerFailureCode } from "../adapters/gemini-error-class.js";
import { GeminiFileError } from "../adapters/gemini-files.js";
import { DEFAULT_GEMINI_MODEL, geminiModelSchema } from "../adapters/gemini-model.js";
import { resolveTranscriptLanguage } from "../domain/transcript-language.js";
import { resolveRetention, type RetentionFlags } from "../domain/retention.js";
import type { DerivedTranscriptionSegment } from "../domain/types.js";
import { sha256File } from "../lib/files.js";
import { measureTrack, recheckTranscript } from "./transcript-coverage.js";
import { decodeSpeechEnvelope, extractAudioTrack, planTranscriptionWindows, probeDurationSeconds } from "./audio.js";
import { mergeTranscriptionChunks, offsetTranscriptionSegments, TranscriptWindowTimeError } from "./transcript.js";
import { TRANSCRIPTION_OVERLAP_SECONDS, TRANSCRIPTION_WINDOW_SECONDS } from "./transcription-policy.js";
import { assertTranscriptTarget, renderSpeakers, renderSrt, renderTranscriptJson, writePrivateAtomic } from "./transcript-render.js";

export class TranscribeError extends Error {
  constructor(message: string, readonly code: FaultCode = "COMMAND_FAILED", readonly diagnostic?: string) { super(message); }
}
export class TranscribeCanceledError extends TranscribeError {
  constructor() { super("Transcription canceled; no transcript files written.", "CANCELLED"); }
}
export interface TranscribeOptions extends RetentionFlags {
  input: string;
  transcriptLanguage?: string;
  output?: string;
  model?: string;
  json?: boolean;
  /** Experimental: ask again about quiet-looking stretches. Can add lines that are not in the recording. */
  recheck?: boolean;
  force?: boolean;
  apiKey?: string;
  signal?: AbortSignal;
}
export interface TranscriptionAnalyzer {
  readonly model: string;
  upload(path: string, mimeType: string): Promise<GeminiFile>;
  transcribe(file: GeminiFile, requestedLanguage?: string, durationSeconds?: number): Promise<DerivedTranscriptionSegment[]>;
  delete(file: GeminiFile): Promise<void>;
  usageSnapshot?(): { promptTokens: number; outputTokens: number; totalTokens: number } | undefined;
}
export interface TranscribeDependencies {
  createAnalyzer: (apiKey: string, model: string) => TranscriptionAnalyzer;
  extractAudioTrack: typeof extractAudioTrack;
  decodeSpeechEnvelope: typeof decodeSpeechEnvelope;
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
export async function transcribe(options: TranscribeOptions, injected: Partial<TranscribeDependencies> = {}, job?: { scratchRoot: string; authorize: () => Promise<void> }) {
  const deps: TranscribeDependencies = {
    createAnalyzer: (key, model) => new GeminiVideoAnalyzer(key, model),
    extractAudioTrack, probeDurationSeconds, decodeSpeechEnvelope,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    stdout: line => { process.stdout.write(`${line}\n`); },
    stderr: line => { process.stderr.write(`${line}\n`); },
    now: () => new Date().toISOString(), ...injected,
  };
  const requestedLanguage = resolveTranscriptLanguage(options.transcriptLanguage);
  const canceled = () => { if (options.signal?.aborted) throw new TranscribeCanceledError(); };
  const model = options.model ?? (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
  if (!geminiModelSchema.safeParse(model).success) throw new TranscribeError("--model must be a Gemini model ID.", "USAGE");
  let retention;
  try { retention = resolveRetention(options, applicationSetting("FRAME_OF_MIND_UPLOAD_RETENTION")); }
  catch { throw new TranscribeError("Upload retention flags must agree and select provider or run.", "USAGE"); }
  deps.stderr(`retention: ${retention}`);
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new TranscribeError("Set GEMINI_API_KEY before transcription.", "KEY_MISSING");
  canceled();
  const input = resolve(options.input);
  const output = resolve(options.output ?? dirname(input));
  const stem = basename(input, extname(input));
  const paths = [join(output, `${stem}.srt`), join(output, `${stem}_speakers.txt`),
    ...(options.json ? [join(output, `${stem}.transcript.json`)] : [])];
  try {
    const original = await stat(input);
    if (!original.isFile()) throw new TranscribeError("Check the input file; expected a regular file.", "INVALID_INPUT");
    for (const path of paths) {
      await assertTranscriptTarget(path, options.force);
      const target = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (path === input || (target && target.dev === original.dev && target.ino === original.ino)) {
        throw new TranscribeError("A transcript target would replace the input recording; choose another output directory.", "CONFLICT");
      }
    }
  } catch (error) {
    if (error instanceof TranscribeError) throw error;
    throw new TranscribeError("Check the input file and output targets; existing targets require --force. See docs/RUNBOOK.md §3.11.", faultCode(error));
  }
  const duration = await deps.probeDurationSeconds(input);
  canceled();
  if (duration === undefined) throw new TranscribeError("Cannot read recording duration. Check ffprobe and the input file; see docs/RUNBOOK.md §6.20.", "DECODE_FAILED");
  const windows = planTranscriptionWindows(duration, TRANSCRIPTION_WINDOW_SECONDS, TRANSCRIPTION_OVERLAP_SECONDS);
  const analyzer = deps.createAnalyzer(apiKey, model);
  deps.stdout(`model: ${model}; duration: ${Math.round(duration)} s; windows: ${windows.length}; retention: ${retention}; upload limit: 2 GB`);
  const temp = await createScratch("transcribe", job?.scratchRoot);
  const chunks: Array<{ segments: DerivedTranscriptionSegment[]; nominalStartSeconds: number }> = [];
  try {
    for (const [index, window] of windows.entries()) {
      await job?.authorize();
      canceled();
      const audioPath = join(temp, `audio-${index + 1}.aac`);
      try {
        if (!(await deps.extractAudioTrack(input, audioPath, {
          ...(job ? {confinedInput: true, signal: options.signal} : {}),
          ...(window.startSeconds ? { startSeconds: window.startSeconds } : {}),
          durationSeconds: window.durationSeconds,
        }))) throw new TranscribeError("No audio track could be extracted. Check ffmpeg and the recording's audio; see docs/RUNBOOK.md §6.20.", "DECODE_FAILED");
        canceled();
        const attempts = job ? 1 : 2;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          canceled();
          let remote: GeminiFile | undefined;
          try {
            remote = await analyzer.upload(audioPath, "audio/aac");
            if (retention === "provider") deps.stderr(`kept audio upload: ${uploadLabel(remote)}`);
            if (job) canceled();
            const segments = await analyzer.transcribe(remote, requestedLanguage, window.durationSeconds);
            chunks.push({
              segments: offsetTranscriptionSegments(segments, window.startSeconds, window.durationSeconds),
              nominalStartSeconds: window.nominalStartSeconds,
            });
            deps.stdout(`window ${index + 1}/${windows.length}: ${segments.length} segment(s)`);
            break;
          } catch (error) {
            if (error instanceof GeminiFileError && error.uploadCleanup === "unconfirmed") {
              deps.stderr("warning: failed audio upload cleanup is unconfirmed; provider expiry applies.");
            }
            canceled();
            if (attempt === attempts) {
              const code = providerFailureCode(error);
              const diagnostic = error instanceof TranscriptWindowTimeError
                ? `A transcript time fell outside audio window ${index + 1}.` : undefined;
              throw new TranscribeError(`Transcription failed on window ${index + 1} after ${attempts} attempt${attempts === 1 ? "" : "s"}; no transcript files written.`, code, diagnostic);
            }
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
  } finally { if (!job) await rm(temp, { recursive: true, force: true }); }
  canceled();
  const warn = (message: string) => deps.stderr(`warning: ${message}`);
  const held = mergeTranscriptionChunks(chunks, warn);
  const mediaOptions = { signal: options.signal, confinedInput: Boolean(job) };
  const boundaries = await measureTrack(input, deps.decodeSpeechEnvelope, mediaOptions);
  const { segments, fields, unchecked } = await recheckTranscript(held, duration, windows.length, boundaries, {
    ...mediaOptions, input, scratchParent: job?.scratchRoot, checkCanceled: canceled, authorize: job?.authorize,
    recheck: Boolean(options.recheck),
    extract: deps.extractAudioTrack,
    upload: async path => {
      const remote = await analyzer.upload(path, "audio/aac");
      if (retention === "provider") deps.stderr(`kept audio upload: ${uploadLabel(remote)}`);
      return remote;
    },
    transcribe: (remote, seconds) => analyzer.transcribe(remote, requestedLanguage, seconds),
    release: async remote => {
      if (retention === "run") {
        try { await analyzer.delete(remote); }
        catch { warn(`audio upload deletion unconfirmed: ${uploadLabel(remote)}`); }
      }
    },
    cleanupUnconfirmed: () => warn("failed audio upload cleanup is unconfirmed; provider expiry applies."),
    notify: (kind, message) => deps.stderr(`${kind === "warning" ? "warning" : "note"}: ${message}`),
  });
  canceled();
  const provenance = {
    model, clock: "source" as const, recordingSha256: await sha256File(input), createdAt: deps.now(),
    ...(requestedLanguage && { requestedLanguage }),
  };
  const srt = renderSrt(segments);
  const texts = [srt.text, renderSpeakers(segments, provenance, unchecked)];
  if (options.json) {
    const windowStarts = windows.map(window => window.nominalStartSeconds);
    texts.push(renderTranscriptJson(segments, provenance, windowStarts, fields));
  }
  canceled();
  await mkdir(output, { recursive: true, mode: 0o700 });
  // Each file is published atomically only after all windows and rendering succeed.
  for (const [index, path] of paths.entries()) {
    await job?.authorize();
    await writePrivateAtomic(path, texts[index]!, { force: options.force });
    deps.stdout(`wrote: ${path}; clock: source`);
  }
  deps.stdout(`segments: ${segments.length}; speakers: ${new Set(segments.map(s => s.speaker)).size}; adjustedCues: ${srt.adjustedCues}; blankCues: ${srt.blankCues}`);
  const usage = analyzer.usageSnapshot?.();
  if (usage) deps.stdout(`tokens: ${JSON.stringify(usage)}`);
  return {
    ...fields, segments, paths, model, language: requestedLanguage ?? null,
    adjustedCues: srt.adjustedCues, blankCues: srt.blankCues,
    retention, ...(usage && { tokens: usage }),
  };
}
