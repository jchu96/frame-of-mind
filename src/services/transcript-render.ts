import { boundMillis } from "../domain/source-bound.js";
import { ContractError } from "../domain/contract-error.js";
import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, rm } from "node:fs/promises";
import type { DerivedTranscriptionSegment } from "../domain/types.js";
import type { MediaClock } from "exact-time";
import { timestampToSeconds } from "../lib/time.js";
import { formatDerivedTranscript } from "./transcript.js";

export interface TranscriptProvenance {
  model: string;
  clock: Extract<MediaClock, "source">;
  recordingSha256: string;
  requestedLanguage?: string;
  createdAt: string;
}

function srtTime(seconds: number): string {
  const milliseconds = Math.round(Math.max(0, seconds) * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(milliseconds / 3_600_000))}:${pad(Math.floor(milliseconds / 60_000) % 60)}:${pad(Math.floor(milliseconds / 1000) % 60)},${pad(milliseconds % 1000, 3)}`;
}

/** Reference-grade context cues; model text cannot introduce timing lines. */
export function renderSrt(segments: readonly DerivedTranscriptionSegment[], maxMs?: number): {
  text: string; adjustedCues: number; blankCues: number;
} {
  const cues: string[] = [];
  let adjustedCues = 0;
  let blankCues = 0;
  for (const segment of segments) {
    const text = segment.text.replace(/\s*[\r\n]+\s*/g, " ").trim().replaceAll("-->", "-- >");
    if (!text) { blankCues += 1; continue; }
    const exact = segment.exactSpan;
    const start = exact ? boundMillis(exact.start) / 1000 : timestampToSeconds(segment.start);
    let end = exact ? Math.min(boundMillis(exact.endExclusive, true), maxMs ?? Infinity) / 1000 : timestampToSeconds(segment.end);
    if (!exact && !(end > start)) { end = start + 1; adjustedCues += 1; }
    cues.push(`${cues.length + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`);
  }
  return { text: cues.length ? `${cues.join("\n")}\n` : "", adjustedCues, blankCues };
}

export function renderSpeakers(segments: DerivedTranscriptionSegment[], provenance: TranscriptProvenance): string {
  const hint = provenance.requestedLanguage ? `; requestedLanguage: ${provenance.requestedLanguage}` : "";
  return `# frame-of-mind transcript; origin: gemini-audio; model: ${provenance.model}; clock: ${provenance.clock}; timing: reference-grade (whole-second)${hint}\n${formatDerivedTranscript(segments)}\n`;
}

export function renderTranscriptJson(
  segments: DerivedTranscriptionSegment[],
  provenance: TranscriptProvenance,
  windowStarts?: readonly number[],
  quietLines?: number,
  fields: object = {},
): string {
  const { adjustedCues, blankCues } = renderSrt(segments);
  return `${JSON.stringify({
    schemaVersion: 1, kind: "frame-of-mind.transcript", ...provenance,
    origin: "gemini-audio", timing: "reference-grade", adjustedCues, blankCues,
    ...(windowStarts && { windowStarts }),
    quietLines, ...fields,
    segments: segments.map(segment => ({
      ...segment, start: timestampToSeconds(segment.start), end: timestampToSeconds(segment.end),
    })),
  }, null, 2)}\n`;
}

export async function assertTranscriptTarget(path: string, force = false): Promise<void> {
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!force) throw new ContractError("CONFLICT", "Transcript target exists; use --force to replace it.");
}

/** Same-directory publication; hard-link publication also refuses concurrent creators. */
export async function writePrivateAtomic(path: string, text: string, options: { force?: boolean } = {}): Promise<void> {
  await assertTranscriptTarget(path, options.force);
  const partial = `${path}.partial-${randomUUID()}`;
  const file = await open(partial, "wx", 0o600);
  try {
    // Private at creation; chmod also restores owner access under a restrictive umask.
    await file.chmod(0o600);
    await file.writeFile(text, "utf8");
    await file.close();
    if (options.force) await rename(partial, path);
    else await link(partial, path);
  } finally {
    try { await file.close(); }
    finally { await rm(partial, { force: true }); }
  }
}
