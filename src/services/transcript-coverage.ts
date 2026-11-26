import { classify } from "../domain/snap.js";
import type { DerivedTranscriptionSegment, TranscriptGap } from "../domain/types.js";
import { timestampToSeconds } from "../lib/time.js";
import type { decodeSpeechEnvelope, SpeechDecodeOptions } from "./audio.js";

/** Merged lines are in start order. Overlapping cues cover their union. */
function* lineFreeStretches(segments: readonly DerivedTranscriptionSegment[], duration: number) {
  let coveredUntil = 0;
  for (const segment of segments) {
    if (!segment.text.trim()) continue;
    const start = Math.min(duration, timestampToSeconds(segment.start));
    if (start - coveredUntil >= 20) yield { start: coveredUntil, end: start };
    coveredUntil = Math.max(coveredUntil, start, timestampToSeconds(segment.end));
  }
  if (duration - coveredUntil >= 20) yield { start: coveredUntil, end: duration };
}

type TranscriptCoverage =
  | { outcome: "complete" | "partial"; gaps: TranscriptGap[] }
  | { outcome: "unchecked"; gaps?: undefined };

export async function checkTranscriptCoverage(
  segments: readonly DerivedTranscriptionSegment[], duration: number | undefined,
  input: string, decode: typeof decodeSpeechEnvelope, options: Pick<SpeechDecodeOptions, "signal" | "confinedInput">,
): Promise<TranscriptCoverage> {
  if (duration === undefined) return { outcome: "unchecked" };
  const gaps: TranscriptGap[] = [];
  for (const { start, end } of lineFreeStretches(segments, duration)) {
    const slice = { startMs: start * 1000, endMs: Math.floor(end * 1000) };
    const envelope = await decode(input, { ...options, slice }).catch(() => undefined);
    if (!envelope) return { outcome: "unchecked" };
    let speechMs = 0;
    for (const { ms, oppositeMs } of classify(envelope).start) {
      speechMs += Math.max(0, Math.min(oppositeMs, slice.endMs) - Math.max(ms, slice.startMs));
    }
    if (speechMs >= 5000) gaps.push({ start, end: Math.round(end), speechSeconds: Math.round(speechMs / 1000) });
  }
  return { outcome: gaps.length ? "partial" : "complete", gaps };
}

export function coverageWarnings(coverage: TranscriptCoverage): string[] {
  if (coverage.outcome === "unchecked") return ["transcript was not checked for missing speech."];
  return coverage.gaps.map(({ start, end, speechSeconds }) =>
    `no transcript for ${start} to ${end} s; ${speechSeconds} s of speech measured there.`);
}
