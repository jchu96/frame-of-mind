const TELEMETRY_CODE_PATTERN = /^[a-z][a-z0-9_:-]{0,119}$/;
const SENSITIVE_TELEMETRY_CODE_PATTERNS = [
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\b(?:GEMINI|GRANOLA|SENTRY|API)[_-]?(?:API[_-]?)?(?:KEY|TOKEN)[_:=-]+\S+/i,
  /\b(?:sk|key|token|secret)[_-][0-9A-Za-z_-]{16,}\b/i,
  /\b[a-f0-9]{64}\b/i,
  /\bnot_[0-9A-Za-z_-]{8,}\b/,
  /\b(?:meeting|recording)[_-]id[_:=-]+[0-9A-Za-z_-]+\b/i,
] as const;

export function isSafeTelemetryCode(value: string): boolean {
  return TELEMETRY_CODE_PATTERN.test(value)
    && !containsSensitiveTelemetryText(value);
}

export function containsSensitiveTelemetryText(value: string): boolean {
  return SENSITIVE_TELEMETRY_CODE_PATTERNS.some((pattern) => pattern.test(value));
}
