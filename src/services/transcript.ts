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

export function nearbyTranscript(
  transcript: string,
  start: string,
  end: string,
  paddingSeconds = 45,
  offsetSeconds = 0,
): string {
  if (!transcript) return "";
  const from = Math.max(0, timestampToSeconds(start) + offsetSeconds - paddingSeconds);
  const to = timestampToSeconds(end) + offsetSeconds + paddingSeconds;
  const lines = transcript.split(/\r?\n/);
  const timed = lines
    .map((line) => ({ line, match: line.match(LINE_TIME) }))
    .filter((entry) => entry.match);
  if (!timed.length) return "";
  return timed
    .filter(({ match }) => {
      const seconds = timestampToSeconds(match![1]!);
      return seconds >= from && seconds <= to;
    })
    .map(({ line }) => line)
    .join("\n");
}
