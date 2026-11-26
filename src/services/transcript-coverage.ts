import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { File as RemoteFile } from "@google/genai";
import { GeminiFileError } from "../adapters/gemini-files.js";
import { createScratch } from "../adapters/scratch.js";
import { classify, type Boundaries } from "../domain/snap.js";
import type { DerivedTranscriptionSegment as Line, TranscriptRecheck, TranscriptRecheckFields, TranscriptSpan } from "../domain/types.js";
import { timestampToSeconds } from "../lib/time.js";
import type { decodeSpeechEnvelope, extractAudioTrack, SpeechDecodeOptions } from "./audio.js";
import { addedSpans, recoverLines } from "./transcript-recovery.js";
import { offsetTranscriptionSegments, TranscriptWindowTimeError } from "./transcript.js";
import { TRANSCRIPTION_WINDOW_SECONDS } from "./transcription-policy.js";

// In one 7200 s recording, 50 line-free stretches held 2673 s of audio. Cutoffs
// of 5, 10 and 15 s selected 11/1046 s, 4/619 s and 1/218 s. A cutoff of 10 was
// tried first and missed the one real early stop on record: a 53 s tail holding
// two whole sentences measured between 5 and 10 s and was never asked about.
// At 5, that recording costs 11 re-asks over 1046 s, inside its budget of 12
// requests and 1800 s.
const MIN_MEASURED_SECONDS = 5;
const MIN_REQUEST_BUDGET = 3;
const AUDIO_BUDGET_FRACTION = 0.25;

export async function measureTrack(input: string, decode: typeof decodeSpeechEnvelope, options: Pick<SpeechDecodeOptions, "signal" | "confinedInput">) {
  try {
    const envelope = await decode(input, options);
    return envelope?.length ? classify(envelope) : undefined;
  } catch { return undefined; }
}

function* lineFreeStretches(segments: readonly Line[], duration: number) {
  let coveredUntil = 0;
  for (const segment of segments) {
    if (!segment.text.trim()) continue;
    const start = Math.min(duration, timestampToSeconds(segment.start));
    if (start - coveredUntil >= 20) yield { start: coveredUntil, end: start };
    coveredUntil = Math.max(coveredUntil, start, timestampToSeconds(segment.end));
  }
  if (duration - coveredUntil >= 20) yield { start: coveredUntil, end: duration };
}

/** Find the first intersecting run; budget order can differ from clock order. */
function measuredSeconds(runs: Boundaries["start"], {start, end}: TranscriptSpan) {
  let lo = 0, hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid]!.oppositeMs <= start * 1000) lo = mid + 1;
    else hi = mid;
  }
  let ms = 0;
  for (let i = lo; i < runs.length && runs[i]!.ms < end * 1000; i++) {
    ms += Math.min(end * 1000, runs[i]!.oppositeMs) - Math.max(start * 1000, runs[i]!.ms);
  }
  return ms / 1000;
}

function planRechecks(held: Line[], duration: number, windows: number, runs: Boundaries["start"]) {
  const belowCutoff = { stretches: 0, seconds: 0 };
  const candidates = [];
  for (const span of lineFreeStretches(held, duration)) {
    const measured = measuredSeconds(runs, span);
    if (measured >= MIN_MEASURED_SECONDS) candidates.push({ ...span, measuredSeconds: measured });
    else {
      belowCutoff.stretches++;
      belowCutoff.seconds += span.end - span.start;
    }
  }
  candidates.sort((a, b) => b.measuredSeconds - a.measuredSeconds || a.start - b.start);
  const maxRequests = Math.max(MIN_REQUEST_BUDGET, windows);
  const maxAudio = duration * AUDIO_BUDGET_FRACTION;
  let requests = 0, seconds = 0;
  const plan = candidates.map(candidate => {
    const pieces = [];
    for (let start = candidate.start; start < candidate.end; start += TRANSCRIPTION_WINDOW_SECONDS) {
      const end = Math.min(candidate.end, start + TRANSCRIPTION_WINDOW_SECONDS);
      const length = end - start;
      const ask = requests < maxRequests && seconds + length <= maxAudio;
      if (ask) { requests++; seconds += length; }
      pieces.push({ start, end, ask });
    }
    return { candidate, pieces };
  });
  return { plan, requests, seconds, belowCutoff };
}

interface RecheckIO {
  input: string;
  scratchParent?: string;
  signal?: AbortSignal;
  confinedInput?: boolean;
  checkCanceled: () => void;
  authorize?: () => Promise<void>;
  extract: typeof extractAudioTrack;
  upload: (audioPath: string) => Promise<RemoteFile>;
  transcribe: (remote: RemoteFile, duration: number) => Promise<Line[]>;
  release: (remote: RemoteFile) => Promise<void>;
  cleanupUnconfirmed: () => void | Promise<void>;
  notify: (kind: "note" | "recovery" | "quiet" | "warning", message: string) => void | Promise<void>;
}

async function recheckTranscriptPiece(piece: TranscriptSpan, io: RecheckIO): Promise<{ lines: Line[] } | { reason: string }> {
  await io.authorize?.();
  io.checkCanceled();
  let scratch: string | undefined;
  let remote: RemoteFile | undefined;
  const duration = piece.end - piece.start;
  try {
    scratch = await createScratch("transcribe", io.scratchParent);
    const path = join(scratch, "audio-1.aac");
    if (!await io.extract(io.input, path, {
      startSeconds: piece.start, durationSeconds: duration, signal: io.signal, confinedInput: io.confinedInput,
    })) return { reason: "audio extraction failed" };
    io.checkCanceled();
    remote = await io.upload(path);
    io.checkCanceled();
    const reply = await io.transcribe(remote, duration);
    return { lines: offsetTranscriptionSegments(reply, piece.start, duration) };
  } catch (error) {
    io.checkCanceled();
    if (error instanceof GeminiFileError && error.uploadCleanup === "unconfirmed") await io.cleanupUnconfirmed();
    return { reason: error instanceof TranscriptWindowTimeError ? "reply time outside clip" : "request failed" };
  } finally {
    try { if (remote) await io.release(remote); }
    finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }
}

// A line is marked only when its own span holds no measured sound at all. In a
// transcript checked word for word, 0 of 603 real lines had none, 21 had under
// 0.5 s and 127 under 1 s, so any looser rule would mark real speech. The mark
// catches a line written into true silence; it proves nothing in a noisy room.
function markQuietLines(lines: Line[], runs: Boundaries["start"]): Line[] {
  return lines.map(line => {
    if (!line.text.trim()) return line;
    const start = timestampToSeconds(line.start), end = timestampToSeconds(line.end);
    // A line whose end is not after its start is shown for one second.
    return measuredSeconds(runs, { start, end: end > start ? end : start + 1 }) === 0 ? { ...line, quiet: true as const } : line;
  });
}

interface Coverage {
  segments: Line[];
  fields: TranscriptRecheckFields & { outcome: "unchecked" | "complete" };
  unchecked: string[];
}

export async function recheckTranscript(held: Line[], duration: number, windows: number, boundaries: Boundaries | undefined, io: RecheckIO): Promise<Coverage> {
  io.checkCanceled();
  if (!boundaries) {
    const reason = `0 to ${duration} s was not checked again (sound measurement unavailable).`;
    await io.notify("warning", reason);
    return { segments: held, fields: { outcome: "unchecked" }, unchecked: [reason] };
  }

  const { plan, requests, seconds, belowCutoff } = planRechecks(held, duration, windows, boundaries.start);
  if (requests) await io.notify("note", `asking again for ${requests} stretch(es), ${seconds} s of audio.`);

  const rechecks: TranscriptRecheck[] = [];
  const unchecked: string[] = [];
  const additions: Line[] = [];
  for (const { candidate, pieces } of plan) {
    const recovered: Line[] = [];
    let failed = false, skipped = false;
    for (const piece of pieces) {
      const result = piece.ask ? await recheckTranscriptPiece(piece, io) : { reason: "budget limit" };
      io.checkCanceled();
      if ("reason" in result) {
        if (piece.ask) failed = true;
        else skipped = true;
        const interval = `${piece.start} to ${piece.end} s`;
        unchecked.push(interval);
        await io.notify("warning", `${interval} was not checked again (${result.reason}); it holds ${measuredSeconds(boundaries.start, piece)} s of measured sound.`);
      } else {
        const lines = recoverLines(result.lines, piece, held, recovered);
        recovered.push(...lines);
        if (lines.length) {
          const spans = addedSpans(lines);
          await io.notify("recovery", `recovered ${lines.length} line(s) at ${spans[0]!.start} to ${spans.at(-1)!.end} s.`);
        }
      }
    }
    for (const line of recovered) additions.push(line);
    const status = failed ? "failed" : skipped ? "skipped" : recovered.length ? "linesAdded" : "noNewLines";
    rechecks.push({ ...candidate, status, addedLines: recovered.length, ...(recovered.length > 0 && { addedSpans: addedSpans(recovered) }) });
  }
  const empty = rechecks.filter(row => row.status === "noNewLines").length;
  if (empty) await io.notify("note", `${empty} stretch(es) asked again with nothing found.`);
  const merged = [...held, ...additions].sort((a, b) => timestampToSeconds(a.start) - timestampToSeconds(b.start));
  const segments = markQuietLines(merged, boundaries.start);
  const quietLines = segments.filter(line => line.quiet).length;
  if (quietLines) await io.notify("quiet", `${quietLines} line(s) sit where no sound was measured.`);
  return { segments, fields: { outcome: unchecked.length ? "unchecked" : "complete", rechecks: rechecks.sort((a, b) => a.start - b.start), belowCutoff, quietLines }, unchecked };
}
