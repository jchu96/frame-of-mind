export const CANONICAL_TIMESTAMP = /^\d{2,}:[0-5]\d:[0-5]\d$/;

export function isCanonicalTimestamp(value: string): boolean {
  return CANONICAL_TIMESTAMP.test(value);
}

export function timestampToSeconds(value: string): number {
  if (!isCanonicalTimestamp(value)) {
    throw new Error(`Invalid timestamp '${value}'. Expected HH:MM:SS.`);
  }
  const [hours, minutes, seconds] = value.split(":").map(Number) as [number, number, number];
  return hours * 3600 + minutes * 60 + seconds;
}

export function parseSignedOffset(value: string): number {
  const match = value.match(/^(-?)(\d{2,}):([0-5]\d):([0-5]\d)$/);
  if (!match) throw new Error("Transcript offset must be a signed HH:MM:SS timestamp.");
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]);
  return match[1] === "-" ? -seconds : seconds;
}

export function parseTranscriptOffset(value: string): number {
  const match = value.match(/^(-?)(?:(\d{1,}):)?([0-5]\d):([0-5]\d)$/);
  if (!match) throw new Error("--transcript-offset must be signed MM:SS or HH:MM:SS.");
  const seconds = Number(match[2] || 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
  return match[1] === "-" ? -seconds : seconds;
}

export function clipWindow(start: string, end: string, paddingSeconds = 8): { start: number; end: number } {
  const startSeconds = timestampToSeconds(start);
  const endSeconds = timestampToSeconds(end);
  if (endSeconds <= startSeconds) throw new Error("Clip end timestamp must be after its start timestamp.");
  return {
    start: Math.max(0, startSeconds - paddingSeconds),
    end: endSeconds + paddingSeconds,
  };
}
