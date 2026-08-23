export interface RecordingDisplayMetadata {
  durationSeconds: number;
  sizeBytes?: number;
}

export function formatRecordingDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "duration unavailable";
  const rounded = Math.max(1, Math.round(seconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remainingSeconds = rounded % 60;
  if (hours) return `${hours} h ${minutes} min`;
  if (minutes) return remainingSeconds ? `${minutes} min ${remainingSeconds} s` : `${minutes} min`;
  return `${remainingSeconds} s`;
}

export function formatRecordingBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "size unavailable";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1_000)), units.length - 1);
  const value = bytes / 1_000 ** unit;
  return `${value.toFixed(unit > 0 && value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatRetentionDuration(seconds: number): string | undefined {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  const units = [
    { seconds: 86_400, singular: "day", plural: "days" },
    { seconds: 3_600, singular: "hour", plural: "hours" },
    { seconds: 60, singular: "minute", plural: "minutes" },
    { seconds: 1, singular: "second", plural: "seconds" },
  ];
  const unit = units.find((candidate) => seconds % candidate.seconds === 0)!;
  const value = seconds / unit.seconds;
  return `${value} ${value === 1 ? unit.singular : unit.plural}`;
}

export function recordingFieldHelp(maxBytes?: number): string {
  const formats = "MP4, MOV, M4V or WebM";
  return maxBytes && Number.isFinite(maxBytes) && maxBytes > 0
    ? `${formats}, up to ${formatRecordingBytes(maxBytes)}`
    : formats;
}

export function recordingDisplayLabel(
  metadata: RecordingDisplayMetadata,
  name = "Recording",
): string {
  return [
    name,
    formatRecordingDuration(metadata.durationSeconds),
    ...(metadata.sizeBytes ? [formatRecordingBytes(metadata.sizeBytes)] : []),
  ].join(" · ");
}
