import type { DerivedTranscriptionSegment } from "../domain/types.js";
import { timestampToSeconds } from "../lib/time.js";

const LINE_TIME = /^\[(\d{2,}:[0-5]\d:[0-5]\d)\]\s/;

export function formatDerivedTranscript(segments: DerivedTranscriptionSegment[]): string {
  return segments
    .map((segment) => `[${segment.start}] ${segment.speaker}: ${segment.text.replace(/\s*\n\s*/g, " ")}`)
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
