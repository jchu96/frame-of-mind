import { spawn } from "node:child_process";
import { access, chmod, rm } from "node:fs/promises";

const AUDIO_EXTRACTION_TIMEOUT_MS = 10 * 60_000;

export interface ExtractAudioTrackOptions {
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
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      ...(options.startSeconds ? ["-ss", String(options.startSeconds)] : []),
      "-i", video,
      ...(options.durationSeconds ? ["-t", String(options.durationSeconds)] : []),
      "-vn", "-map", "0:a:0", "-map_metadata", "-1",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
      "-f", "adts", destination,
    ], { stdio: "ignore" });
    const kill = () => child.kill("SIGKILL");
    const timeout = setTimeout(kill, options.timeoutMs ?? AUDIO_EXTRACTION_TIMEOUT_MS);
    options.signal?.addEventListener("abort", kill, { once: true });
    const settle = (result: number | null) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", kill);
      resolve(result);
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

const DURATION_PROBE_TIMEOUT_MS = 60_000;

/**
 * Reads a media file's duration in seconds with ffprobe. Mirrors the extractor
 * contract: never throws, returns undefined when ffprobe is missing, the probe
 * fails or times out, or the reported duration is not a positive number.
 */
export async function probeDurationSeconds(
  media: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number | undefined> {
  if (options.signal?.aborted) return undefined;
  const output = await new Promise<string | undefined>((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      media,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      // Bound the buffer; a well-formed probe answers in a few bytes.
      if (text.length < 128) text += chunk.toString("utf8");
    });
    const kill = () => child.kill("SIGKILL");
    const timeout = setTimeout(kill, options.timeoutMs ?? DURATION_PROBE_TIMEOUT_MS);
    const settle = (value: string | undefined) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", kill);
      resolve(value);
    };
    options.signal?.addEventListener("abort", kill, { once: true });
    child.once("error", () => settle(undefined));
    child.once("close", (code) => settle(code === 0 ? text : undefined));
  });
  const seconds = Number(String(output ?? "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
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
