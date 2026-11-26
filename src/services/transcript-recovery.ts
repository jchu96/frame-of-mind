import type { DerivedTranscriptionSegment as Line, TranscriptSpan } from "../domain/types.js";
import { timestampToSeconds } from "../lib/time.js";

const startOf = (line: Line) => timestampToSeconds(line.start);
const endOf = (line: Line) => timestampToSeconds(line.end);
const normalized = (line: Line) => line.text.trim().replace(/\s+/g, " ").toLowerCase();

function repeatedEdge(left: Line[], right: Line[]): number {
  const last = left.at(-1), first = right[0];
  if (!last || !first || Math.max(startOf(last), endOf(last)) !== startOf(first)) return 0;
  const limit = Math.min(left.length, right.length);
  const a = left.slice(-limit).map(normalized), b = right.slice(0, limit).map(normalized);
  for (let count = limit; count > 0; count--) {
    let i = 0;
    while (i < count && a[a.length - count + i] === b[i]) i++;
    if (i === count) return count;
  }
  return 0;
}

/** Only the reply is filtered. Prior pieces are processed in clock order and win at a seam. */
export function recoverLines(reply: Line[], piece: TranscriptSpan, held: Line[], earlier: Line[]): Line[] {
  const neighbors = held.filter(line => startOf(line) < piece.end && endOf(line) > piece.start);
  const exact = new Set<string>();
  const lines = reply.filter(line => {
    const start = startOf(line), end = endOf(line);
    if (!line.text.trim() || start < piece.start || start >= piece.end || end < piece.start || end > piece.end) return false;
    if (end > start && neighbors.some(other => startOf(other) < endOf(other) && start < endOf(other) && startOf(other) < end)) return false;
    const key = JSON.stringify([line.start, line.end, line.speaker, line.text]);
    if (exact.has(key)) return false;
    exact.add(key);
    return true;
  }).sort((a, b) => startOf(a) - startOf(b));
  if (!lines.length) return [];
  const left = [...held.filter(line => endOf(line) <= piece.start && startOf(line) <= piece.start), ...earlier];
  lines.splice(0, repeatedEdge(left, lines));
  const right = held.filter(line => startOf(line) >= piece.end);
  lines.splice(lines.length - repeatedEdge(lines, right));
  return lines.map(line => ({ ...line, recovered: true }));
}

export function addedSpans(lines: Line[]): TranscriptSpan[] {
  const spans: TranscriptSpan[] = [];
  for (const line of lines) {
    const start = startOf(line), end = Math.max(start, endOf(line));
    const last = spans.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  }
  return spans;
}
