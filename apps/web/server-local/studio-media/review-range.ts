export const MAX_REVIEW_RANGE_BYTES = 8 * 1_024 * 1_024;

export interface ReviewByteRange {
  start: number;
  end: number;
}

export function parseReviewByteRange(
  header: string | undefined,
  size: number,
  maximumBytes = MAX_REVIEW_RANGE_BYTES,
): ReviewByteRange | undefined {
  if (!header) return undefined;
  if (
    !Number.isSafeInteger(size)
    || size <= 0
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes <= 0
  ) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    const length = Math.min(suffix, size, maximumBytes);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) {
    return undefined;
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1, start + maximumBytes - 1),
  };
}
