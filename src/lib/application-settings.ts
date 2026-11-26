// Only the ordinary CLI installs a folder settings reader. Shared Studio and
// library callers retain their own environment and never discover a folder file.
export type ApplicationSetting = "GEMINI_MODEL" | "GRANOLA_API_KEY" | "GRANOLA_MCP_URL" | "BLUEDOT_MCP_URL"
  | "FRAME_OF_MIND_OUTPUT" | "FRAME_OF_MIND_UPLOAD_RETENTION" | "FRAME_OF_MIND_DETAIL_CONCURRENCY"
  | "FRAME_OF_MIND_MAX_VIDEO_SECONDS" | "SENTRY_DSN" | "SENTRY_DEBUG" | "FRAME_OF_MIND_TRACING"
  | "FRAME_OF_MIND_TRACES_SAMPLE_RATE";

let read: (name: ApplicationSetting) => string | undefined = name => process.env[name];
export function applicationSetting(name: ApplicationSetting) { return read(name); }
export function useApplicationSettings(reader: typeof read) { read = reader; }
