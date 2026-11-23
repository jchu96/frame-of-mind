import { clockTime, transcriptToFile } from "../domain/clock.js";
import type { DerivedTranscriptionSegment } from "../domain/types.js";
import { secondsToTimestamp, timestampToSeconds } from "../lib/time.js";

const LINE_TIME = /^\[(\d{2,}:[0-5]\d:[0-5]\d)\]\s/;

/**
 * Shifts a chunk's segments from chunk-relative time onto recording time.
 * Segments that would land before the recording start are impossible and are
 * treated as a model error rather than silently clamped.
 */
export function offsetTranscriptionSegments(
  segments: DerivedTranscriptionSegment[],
  offsetSeconds: number,
): DerivedTranscriptionSegment[] {
  if (!offsetSeconds) return segments;
  return segments.map((segment) => ({
    ...segment,
    start: secondsToTimestamp(timestampToSeconds(segment.start) + offsetSeconds),
    end: secondsToTimestamp(timestampToSeconds(segment.end) + offsetSeconds),
  }));
}

/**
 * Merges chunk transcripts into one recording-time transcript. Chunks carry a
 * lead-in overlap so the model has context at a boundary; segments starting
 * inside that overlap were already transcribed by the previous chunk, so the
 * caller passes the chunk's nominal (non-overlapped) start and anything before
 * it is dropped. Output stays ordered by start time.
 */
export function mergeTranscriptionChunks(
  chunks: Array<{ segments: DerivedTranscriptionSegment[]; nominalStartSeconds: number }>,
): DerivedTranscriptionSegment[] {
  const merged: DerivedTranscriptionSegment[] = [];
  for (const chunk of chunks) {
    for (const segment of chunk.segments) {
      if (timestampToSeconds(segment.start) < chunk.nominalStartSeconds) continue;
      merged.push(segment);
    }
  }
  return merged.sort(
    (left, right) => timestampToSeconds(left.start) - timestampToSeconds(right.start),
  );
}

export function formatDerivedTranscript(segments: DerivedTranscriptionSegment[]): string {
  const flatten = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return segments
    .map((segment) => `[${segment.start}] ${flatten(segment.speaker)}: ${flatten(segment.text)}`)
    .join("\n");
}

/** Legacy model offsets allow any finite number; only exact ms offsets are verified. */
export function transcriptOffsetVerified(offsetSeconds: number, transcript = ""): boolean {
  try {
    transcriptToFile(clockTime("transcript", 0), offsetSeconds);
    for (const line of transcript.split(/\r?\n/)) {
      const match = line.match(LINE_TIME);
      if (match) transcriptToFile(clockTime("transcript", timestampToSeconds(match[1]!) * 1000), offsetSeconds);
    }
    return true;
  }
  catch { return false; }
}

export function nearbyTranscript(
  transcript: string,
  start: string,
  end: string,
  paddingSeconds = 45,
  offsetSeconds = 0,
): string {
  if (!transcript) return "";
  // K5/K7: retain the base selection for legacy model offsets that cannot be
  // represented as integer milliseconds. Do not round or claim this is verified.
  if (!transcriptOffsetVerified(offsetSeconds, transcript)) {
    const from = Math.max(0, timestampToSeconds(start) + offsetSeconds - paddingSeconds);
    const to = timestampToSeconds(end) + offsetSeconds + paddingSeconds;
    return transcript.split(/\r?\n/).filter(line => {
      const match = line.match(LINE_TIME);
      return match && timestampToSeconds(match[1]!) >= from && timestampToSeconds(match[1]!) <= to;
    }).join("\n");
  }
  const from = Math.max(transcriptToFile(clockTime("transcript", 0), offsetSeconds).ms, (timestampToSeconds(start) - paddingSeconds) * 1000);
  const to = (timestampToSeconds(end) + paddingSeconds) * 1000;
  const lines = transcript.split(/\r?\n/);
  const timed = lines
    .map((line) => ({ line, match: line.match(LINE_TIME) }))
    .filter((entry) => entry.match);
  if (!timed.length) return "";
  return timed
    .filter(({ match }) => {
      const time = transcriptToFile(clockTime("transcript", timestampToSeconds(match![1]!) * 1000), offsetSeconds);
      return time.ms >= from && time.ms <= to;
    })
    .map(({ line }) => line)
    .join("\n");
}

/** Only timestamped lines can be mapped safely; prose-only context remains intact. */
export function windowTranscript(transcript: string, offsetSeconds: number, durationSeconds: number | undefined): { text: string; windowed: boolean } {
  const timed = transcript.split(/\r?\n/).map(line => ({ line, match: line.match(LINE_TIME) })).filter(entry => entry.match);
  // Preserve legacy numeric API inputs when exact windowing is unavailable.
  // The orchestrator labels the unchanged context as unwindowed/unverified.
  if (!timed.length || durationSeconds === undefined || !transcriptOffsetVerified(offsetSeconds, transcript)) return { text: transcript, windowed: false };
  return { windowed: true, text: timed.flatMap(({ line, match }) => {
    const time = transcriptToFile(clockTime("transcript", timestampToSeconds(match![1]!) * 1000), offsetSeconds);
    return time.ms >= 0 && time.ms < durationSeconds * 1000
      ? [line.replace(match![1]!, secondsToTimestamp(time.ms / 1000))] : [];
  }).join("\n") };
}
