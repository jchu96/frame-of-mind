/** Return the canonical BCP-47 tag, or undefined for invalid input. */
export function canonicalLanguageTag(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

export class TranscriptLanguageError extends Error {}

export function resolveTranscriptLanguage(tag?: string, derive = true): string | undefined {
  if (tag === undefined) return undefined;
  if (!derive) throw new TranscriptLanguageError("--transcript-language conflicts with --no-derived-transcript.");
  const canonical = canonicalLanguageTag(tag);
  if (!canonical) throw new TranscriptLanguageError("--transcript-language requires a valid BCP-47 language tag.");
  return canonical;
}
