import { z } from "zod";
import type { MeetingContextSource, MeetingEvidence } from "../domain/types.js";
import { extractGranolaTranscript } from "./granola-mcp.js";

const GRANOLA_API_ORIGIN = "https://public-api.granola.ai";
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const granolaNoteSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  created_at: z.string().optional(),
  web_url: z.string().url().optional(),
  summary_text: z.string().optional(),
  summary_markdown: z.string().optional(),
  transcript: z.array(z.object({
    speaker: z.object({
      source: z.string().optional(),
      diarization_label: z.string().optional(),
    }).passthrough().optional(),
    text: z.string(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export class GranolaApiClient implements MeetingContextSource {
  readonly provider = "granola" as const;

  constructor(private readonly apiKey = process.env.GRANOLA_API_KEY) {}

  async connect(): Promise<void> {
    if (!this.apiKey) {
      throw new Error(
        "Set GRANOLA_API_KEY or use the default Granola MCP transport with browser OAuth.",
      );
    }
  }

  async close(): Promise<void> {}

  async meeting(meetingId: string): Promise<MeetingEvidence> {
    if (!/^not_[a-zA-Z0-9]{14}$/.test(meetingId)) {
      throw new Error(
        "Granola API note IDs use the documented 'not_' identifier format. " +
        "Use the note ID returned by the Granola List Notes API, or use --granola-transport mcp.",
      );
    }
    const url = new URL(`/v1/notes/${encodeURIComponent(meetingId)}`, GRANOLA_API_ORIGIN);
    url.searchParams.set("include", "transcript");
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        "user-agent": "frameofmind/0.1.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(granolaApiError(response.status));
    }
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new Error("Granola API response exceeds the 20 MB safety limit.");
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new Error("Granola API response exceeds the 20 MB safety limit.");
    }
    const raw = granolaNoteSchema.parse(JSON.parse(text));
    return {
      id: raw.id,
      provider: this.provider,
      transport: "api",
      ...(raw.title ? { title: raw.title } : {}),
      ...(raw.created_at ? { createdAt: raw.created_at } : {}),
      ...(raw.web_url ? { sourceUrl: raw.web_url } : {}),
      ...(raw.summary_markdown || raw.summary_text
        ? { summary: raw.summary_markdown || raw.summary_text }
        : {}),
      transcript: extractGranolaTranscript(raw.transcript || []),
      raw,
    };
  }
}

function granolaApiError(status: number): string {
  if (status === 401 || status === 403) {
    return "Granola API authorization failed. Verify the key, note scope, workspace policy, and plan.";
  }
  if (status === 404) {
    return "Granola API note was not found or is not yet summarized/transcribed.";
  }
  if (status === 429) {
    return "Granola API rate limit exceeded. Retry after the provider window resets.";
  }
  return `Granola API request failed with HTTP ${status}.`;
}
