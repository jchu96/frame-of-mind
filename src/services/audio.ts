import { ContractError } from "../domain/contract-error.js";
import { resolve } from "node:path";
import { decimalMs, SpeechMeter, type Envelope } from "../domain/snap.js";
import { childEnvironment, spawn } from "../lib/child-env.js";
import { access, chmod, rm } from "node:fs/promises";
import { closeSync, constants, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { openJobFile } from "../adapters/job-path.js";

// Give job decoders a seekable descriptor and allow only its protocol. Even a
// container referring to a secondary local file cannot ask FFmpeg to open it.
function withAudioInput<T>(video: string, confined: boolean | undefined,
  launch: (input: string, flags: string[], stdin: number | "ignore") => T): T {
  if (!confined) return launch(video, [], "ignore");
  const fd = openJobFile(video, constants.O_RDONLY);
  try { return launch("fd:", ["-protocol_whitelist", "fd", "-format_whitelist", "mov,matroska,webm"], fd); }
  finally { closeSync(fd); }
}

const AUDIO_EXTRACTION_TIMEOUT_MS = 10 * 60_000;

export interface ExtractAudioTrackOptions {
  confinedInput?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Window start in seconds. Omit to start at the beginning. */
  startSeconds?: number;
  /** Window length in seconds. Omit to extract to the end of the track. */
  durationSeconds?: number;
}

/**
 * Extracts the first audio stream from a local recording into an ADTS AAC
 * file suitable for a Gemini `audio/aac` upload. Mirrors the screenshot
 * extractor contract: never throws, returns false when ffmpeg is missing,
 * the recording has no audio track, extraction is aborted or times out, or
 * the derivative was not produced.
 */
export async function extractAudioTrack(
  video: string,
  destination: string,
  options: ExtractAudioTrackOptions = {},
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  const code = await new Promise<number | null>((resolve) => {
    // `-ss` precedes `-i` so ffmpeg seeks the input rather than decoding and
    // discarding the leading window; `-t` then bounds the extracted length.
    const child = withAudioInput(video, options.confinedInput, (input, flags, stdin) => spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      ...flags,
      ...(options.startSeconds ? ["-ss", String(options.startSeconds)] : []),
      "-i", input,
      ...(options.durationSeconds ? ["-t", String(options.durationSeconds)] : []),
      "-vn", "-map", "0:a:0", "-map_metadata", "-1",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
      "-f", "adts", options.confinedInput ? "pipe:1" : destination,
    ], { env: childEnvironment("media"), stdio: [stdin, options.confinedInput ? "pipe" : "ignore", "ignore"] }));
    // Job derivatives stream through their worker. Its death closes the pipe,
    // so a decoder cannot keep writing a derivative after recovery.
    const copied = options.confinedInput
      ? pipeline(child.stdout!, createWriteStream(destination, {flags: "wx", mode: 0o600})).then(() => true, () => false)
      : Promise.resolve(true);
    const kill = () => child.kill("SIGKILL");
    const timeout = setTimeout(kill, options.timeoutMs ?? AUDIO_EXTRACTION_TIMEOUT_MS);
    options.signal?.addEventListener("abort", kill, { once: true });
    const settle = (result: number | null) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", kill);
      void copied.then(ok => resolve(ok ? result : null));
    };
    child.once("error", () => settle(null));
    child.once("close", settle);
  });
  if (code !== 0) {
    await rm(destination, { force: true });
    return false;
  }
  try {
    await access(destination);
    await chmod(destination, 0o600);
    return true;
  } catch {
    await rm(destination, { force: true });
    return false;
  }
}

const MEDIA_PROBE_TIMEOUT_MS = 60_000;

async function probePositiveNumber(media: string, fields: string[], options: { signal?: AbortSignal; timeoutMs?: number; confinedInput?: boolean }) {
  if (options.signal?.aborted) return undefined;
  const output = await new Promise<string | undefined>((resolve) => {
    const child = withAudioInput(media, options.confinedInput, (input, flags, stdin) => spawn("ffprobe", [
      "-v", "error",
      ...flags, ...fields,
      "-of", "default=noprint_wrappers=1:nokey=1",
      input,
    ], { env: childEnvironment("media"), stdio: [stdin, "pipe", "ignore"] }));
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      // Bound the buffer; a well-formed probe answers in a few bytes.
      if (text.length < 128) text += chunk.toString("utf8");
    });
    const kill = () => child.kill("SIGKILL");
    const timeout = setTimeout(kill, options.timeoutMs ?? MEDIA_PROBE_TIMEOUT_MS);
    const settle = (value: string | undefined) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", kill);
      resolve(value);
    };
    options.signal?.addEventListener("abort", kill, { once: true });
    child.once("error", () => settle(undefined));
    child.once("close", (code) => settle(code === 0 ? text : undefined));
  });
  const value = Number(output?.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Reads a media file's duration in seconds with ffprobe. Mirrors the extractor
 * contract: never throws, returns undefined when ffprobe is missing, the probe
 * fails or times out, or the reported duration is not a positive number.
 */
export async function probeDurationSeconds(
  media: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number | undefined> {
  return probePositiveNumber(media, ["-show_entries", "format=duration"], options);
}

export interface TranscriptionWindow {
  /** Where extraction starts, including the lead-in overlap. */
  startSeconds: number;
  durationSeconds: number;
  /** First second this window owns; earlier audio belongs to the previous window. */
  nominalStartSeconds: number;
}

/**
 * Splits a duration into transcription windows. A single window covers short
 * recordings unchanged; longer ones are chunked so no request has to emit a
 * verbatim transcript longer than the model's output budget. Each window after
 * the first begins `overlapSeconds` early so the model sees the sentence it is
 * joining mid-way.
 */
export function planTranscriptionWindows(
  durationSeconds: number,
  windowSeconds: number,
  overlapSeconds: number,
): TranscriptionWindow[] {
  if (!(durationSeconds > 0) || !(windowSeconds > 0)) {
    throw new Error("Transcription windows need a positive duration and window length.");
  }
  if (durationSeconds <= windowSeconds) {
    return [{ startSeconds: 0, durationSeconds, nominalStartSeconds: 0 }];
  }
  const overlap = Math.max(0, Math.min(overlapSeconds, windowSeconds - 1));
  const windows: TranscriptionWindow[] = [];
  for (let nominal = 0; nominal < durationSeconds; nominal += windowSeconds) {
    const startSeconds = nominal === 0 ? 0 : nominal - overlap;
    windows.push({
      startSeconds,
      durationSeconds: Math.min(durationSeconds, nominal + windowSeconds) - startSeconds,
      nominalStartSeconds: nominal,
    });
  }
  return windows;
}

export interface SpeechDecodeOptions {
  confinedInput?: boolean;
  reportFailure?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  slice?: { startMs: number; endMs: number };
}

/** Both tee outputs describe the same encoded packets. PCM alone has no file clock. */
export async function decodeSpeechEnvelope(video: string, options: SpeechDecodeOptions = {}): Promise<Envelope | undefined> {
  const { signal, slice } = options;
  if (signal?.aborted) return undefined;
  if (options.reportFailure) await access(resolve(video));
  const deadline = Date.now() + (options.timeoutMs ?? AUDIO_EXTRACTION_TIMEOUT_MS);
  const envelope = await new Promise<Envelope | undefined>((resolveResult, reject) => {
    const child = withAudioInput(resolve(video), options.confinedInput, (input, flags, stdin) => spawn("ffmpeg", [
      "-nostdin", "-v", "error", "-copyts", "-start_at_zero",
      ...flags,
      ...(slice ? ["-ss", decimalMs(slice.startMs), "-t", decimalMs(slice.endMs - slice.startMs)] : []),
      "-i", input, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000",
      ...(slice ? ["-af", `atrim=end=${decimalMs(slice.endMs)}`] : []),
      "-c:a", "pcm_s16le", "-f", "tee", "[f=framecrc:flush_packets=1]pipe:2|[f=s16le]pipe:1",
    ], { env: childEnvironment("media"), stdio: [stdin, "pipe", "pipe"] }));
    const stdout = child.stdout!;
    const stderr = child.stderr!;
    let failed = false;
    const stop = () => {
      failed = true;
      stdout.resume();
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(stop, options.timeoutMs ?? AUDIO_EXTRACTION_TIMEOUT_MS);
    signal?.addEventListener("abort", stop, { once: true });
    let meter: SpeechMeter | undefined;
    let observedBytes = 0;
    let nextSample: number | undefined;
    let sampleClock = false;
    let pending = "";

    // Read timing before consuming PCM, even if stdout becomes readable first.
    stdout.on("data", (chunk: Buffer) => {
      if (!meter) return stop();
      if (!failed) meter.write(chunk);
    });
    stdout.pause();
    const packet = (line: string) => {
      if (line.startsWith("#")) {
        if (line.trim() === "#tb 0: 1/8000") sampleClock = true;
        return;
      }
      const fields = /^0,\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+),\s*0x[\da-fA-F]+\s*$/.exec(line);
      if (!fields || !sampleClock) return stop();
      const pts = Number(fields[2]);
      const duration = Number(fields[3]);
      const size = Number(fields[4]);
      if (!Number.isSafeInteger(pts) || !Number.isSafeInteger(pts + duration) || duration <= 0 ||
          size !== duration + duration || (nextSample !== undefined && nextSample !== pts)) return stop();
      nextSample = pts + duration;
      observedBytes += size;
      if (!meter) {
        meter = new SpeechMeter(pts);
        stdout.resume();
      }
    };
    stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (failed) return;
      const lines = (pending + chunk).split("\n");
      pending = lines.pop()!;
      if (pending.length > 1024) return stop();
      for (const line of lines) {
        packet(line);
        if (failed) break;
      }
    });
    stderr.once("end", () => stdout.resume());
    stdout.once("error", stop);
    stderr.once("error", stop);
    let missing = false;
    child.once("error", (error: NodeJS.ErrnoException) => {
      missing = error.code === "ENOENT";
      stop();
    });
    child.once("close", code => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      if (code || code === null || failed || pending || !stdout.readableEnded || !stderr.readableEnded ||
          !sampleClock || (meter && meter.bytes !== observedBytes)) {
        if (options.reportFailure) reject(new ContractError(signal?.aborted ? "CANCELLED" : missing ? "CAPABILITY_MISSING" : "DECODE_FAILED",
          "Speech envelope decoding failed."));
        else resolveResult(undefined);
        return;
      }
      resolveResult(meter ? meter.finish() : slice ? { startMs: slice.startMs, blocks: [], length: 0 } : undefined);
    });
  });
  if (signal?.aborted) return undefined;
  if (!envelope?.length) return envelope;
  // Match the decoder's explicit 0:a:0 map. Its resampled PCM always reports 8000 Hz.
  const sourceSampleRateHz = await probePositiveNumber(resolve(video), ["-select_streams", "a:0", "-show_entries", "stream=sample_rate"], {
    signal, confinedInput: options.confinedInput, timeoutMs: Math.min(MEDIA_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
  });
  return signal?.aborted ? undefined : { ...envelope, sourceSampleRateHz };
}
