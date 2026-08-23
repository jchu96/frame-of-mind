const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;

export function safeHostedNext(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    typeof candidate !== "string"
    || !candidate.startsWith("/")
    || candidate.startsWith("//")
    || candidate.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(candidate)
    || SCHEME_PATTERN.test(candidate)
    || SCHEME_PATTERN.test(candidate.slice(1))
  ) return "/";

  return candidate;
}
