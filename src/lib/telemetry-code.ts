const TELEMETRY_CODE_PATTERN = /^[a-z][a-z0-9_:-]{0,119}$/;

export function isSafeTelemetryCode(value: string): boolean {
  return TELEMETRY_CODE_PATTERN.test(value);
}
