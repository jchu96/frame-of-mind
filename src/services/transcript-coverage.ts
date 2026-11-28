import { classify, type Boundaries } from "../domain/snap.js";
import type { DerivedTranscriptionSegment as Line } from "../domain/types.js";
import { timestampToSeconds } from "../lib/time.js";
import type { decodeSpeechEnvelope, SpeechDecodeOptions } from "./audio.js";

export async function measureTrack(input: string, decode: typeof decodeSpeechEnvelope, options: Pick<SpeechDecodeOptions, "signal" | "confinedInput">) {
  try {
    const envelope = await decode(input, options);
    return envelope?.length ? classify(envelope) : undefined;
  } catch { return undefined; }
}

function measuredSeconds(runs: Boundaries["start"], start: number, end: number) {
  let lo = 0, hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid]!.coreEndMs <= start * 1000) lo = mid + 1;
    else hi = mid;
  }
  let ms = 0;
  for (let i = lo; i < runs.length && runs[i]!.coreStartMs < end * 1000; i++) {
    ms += Math.min(end * 1000, runs[i]!.coreEndMs) - Math.max(start * 1000, runs[i]!.coreStartMs);
  }
  return ms / 1000;
}

// A line is marked only when its own span holds no measured sound at all. In a
// transcript checked word for word, 0 of 603 real lines had none, 21 had under
// 0.5 s and 127 under 1 s, so any looser rule would mark real speech. The mark
// catches a line written into true silence; it proves nothing in a noisy room.
export async function markQuietLines(
  lines: Line[],
  boundaries: Boundaries | undefined,
  notify: (message: string) => void | Promise<void>,
): Promise<{ segments: Line[]; quietLines?: number }> {
  if (!boundaries) return { segments: lines };
  const segments = lines.map(line => {
    if (!line.text.trim()) return line;
    const start = timestampToSeconds(line.start), end = timestampToSeconds(line.end);
    // A line whose end is not after its start is shown for one second.
    return measuredSeconds(boundaries.start, start, end > start ? end : start + 1) === 0 ? { ...line, quiet: true as const } : line;
  });
  const quietLines = segments.filter(line => line.quiet).length;
  if (quietLines) await notify(`${quietLines} line(s) sit where no sound was measured.`);
  return { segments, quietLines };
}
