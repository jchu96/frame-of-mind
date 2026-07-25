export function timestampToSeconds(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  return parts[0] ?? 0;
}

export function clipWindow(start: string, end: string, paddingSeconds = 8): { start: number; end: number } {
  const startSeconds = timestampToSeconds(start);
  const endSeconds = Math.max(startSeconds + 1, timestampToSeconds(end));
  return {
    start: Math.max(0, startSeconds - paddingSeconds),
    end: endSeconds + paddingSeconds,
  };
}
