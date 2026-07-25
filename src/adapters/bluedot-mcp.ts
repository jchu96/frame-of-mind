import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_TOKEN_PATH,
  FileOAuthProvider,
  OAuthCallback,
  openBrowser,
  secureTokenDirectory,
} from "./bluedot-oauth.js";
import type { MeetingEvidence, MediaSource } from "../domain/types.js";
import { collectStrings, findMediaUrl, firstStringForKeys } from "../lib/object.js";
import { validateBluedotMediaUrl } from "../lib/files.js";

export const DEFAULT_BLUEDOT_MCP_URL = "https://app.bluedothq.com/api/v1/mcp";
const CALLBACK_PORT = 8765;
const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

export class BluedotClient {
  readonly provider = "bluedot" as const;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private tools: Tool[] = [];

  constructor(
    private readonly serverUrl = process.env.BLUEDOT_MCP_URL || DEFAULT_BLUEDOT_MCP_URL,
    private readonly tokenPath = DEFAULT_TOKEN_PATH,
  ) {}

  async connect(): Promise<void> {
    await secureTokenDirectory(this.tokenPath);
    const callback = new OAuthCallback(CALLBACK_PORT, "Bluedot");
    await callback.listen();
    const provider = new FileOAuthProvider(CALLBACK_URL, this.tokenPath, (url) => {
      process.stderr.write(`Authorize Bluedot in your browser:\n${url.toString()}\n`);
      void openBrowser(url);
    });
    try {
      await this.attemptConnection(provider);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const code = await callback.code;
      await this.transport?.finishAuth(code);
      await this.attemptConnection(provider);
    } finally {
      callback.close();
    }
    this.tools = (await this.client!.listTools()).tools;
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }

  async meeting(meetingId: string): Promise<MeetingEvidence> {
    const tool = this.requireTool("get_meeting");
    const args = argumentForIdentifier(tool, meetingId);
    // Bluedot currently advertises an output schema whose `duration` format
    // rejects its own ISO-8601 value. Validate the MCP envelope without applying
    // the server's inconsistent per-tool output schema.
    const result = await this.client!.request(
      { method: "tools/call", params: { name: tool.name, arguments: args } },
      CallToolResultSchema,
    );
    const raw = normalizeToolResult(result);
    const transcript = extractTranscript(raw);
    return {
      id: firstStringForKeys(raw, /^(meeting_?id|recording_?id|id)$/i) || meetingId,
      provider: this.provider,
      transport: "mcp",
      title: firstStringForKeys(raw, /^(title|name)$/i),
      createdAt: firstStringForKeys(raw, /^(created_?at|date_?created|recorded_?at|start_?time)$/i),
      sourceUrl: `https://app.bluedothq.com/preview/${encodeURIComponent(meetingId)}`,
      summary: firstStringForKeys(raw, /^(summary|meeting_?summary)$/i),
      transcript,
      raw,
    };
  }

  mediaFromMeeting(meeting: MeetingEvidence, overrideUrl?: string): MediaSource {
    if (overrideUrl) return { url: validateBluedotMediaUrl(overrideUrl).toString(), source: "override" };
    const url = findMediaUrl(meeting.raw);
    if (!url) {
      throw new Error(
        "Bluedot get_meeting did not expose a recording URL for this meeting. " +
        "Download the recording in Bluedot or copy its signed recording URL, then rerun with --video or --recording-url.",
      );
    }
    return { url: validateBluedotMediaUrl(url).toString(), source: "mcp" };
  }

  private async attemptConnection(provider: FileOAuthProvider): Promise<void> {
    this.client = new Client({ name: "frame-of-mind", version: "0.1.0" }, { capabilities: {} });
    this.transport = new StreamableHTTPClientTransport(new URL(this.serverUrl), { authProvider: provider });
    await this.client.connect(this.transport);
  }

  private requireTool(name: string): Tool {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Bluedot MCP does not expose required tool '${name}'.`);
    return tool;
  }
}

export function argumentForIdentifier(tool: Tool, value: string): Record<string, string> {
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties || {};
  const preferred = ["videoId", "video_id", "meetingId", "meeting_id", "recordingId", "recording_id", "id"];
  const key = preferred.find((candidate) => candidate in properties) || Object.keys(properties)[0];
  if (!key) throw new Error(`Tool '${tool.name}' has no identifier argument.`);
  return { [key]: value };
}

export function normalizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const object = result as Record<string, unknown>;
  if (object.structuredContent) return object.structuredContent;
  const content = Array.isArray(object.content) ? object.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as Record<string, unknown>).text;
    if (typeof text !== "string") continue;
    try {
      return JSON.parse(text);
    } catch {
      // Continue looking for structured content.
    }
  }
  return object;
}

export function extractTranscript(raw: unknown): string {
  const segments = findTranscriptSegments(raw);
  if (segments.length) {
    return segments
      .map((segment) => {
        const time = formatSeconds(segment.start);
        const speaker = segment.speakerTag || segment.speaker || "Unknown speaker";
        return `[${time}] ${speaker}: ${segment.text}`;
      })
      .join("\n");
  }
  const direct = firstStringForKeys(raw, /^(transcript|transcription|full_?transcript)$/i);
  if (direct) return direct;
  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>)
      .filter(([key]) => /transcript|utterance|segment/i.test(key))
      .flatMap(([, value]) => collectStrings(value));
    if (entries.length) return entries.join("\n");
  }
  return "";
}

interface TranscriptSegment {
  start: number;
  text: string;
  speakerTag?: string;
  speaker?: string;
}

function findTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (Array.isArray(value)) {
    const segments = value.filter(isTranscriptSegment);
    if (segments.length === value.length && segments.length > 0) return segments;
    for (const child of value) {
      const found = findTranscriptSegments(child);
      if (found.length) return found;
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(transcript|transcription|segments|utterances)$/i.test(key) && Array.isArray(child)) {
        const segments = child.filter(isTranscriptSegment);
        if (segments.length) return segments;
      }
      const found = findTranscriptSegments(child);
      if (found.length) return found;
    }
  }
  return [];
}

function isTranscriptSegment(value: unknown): value is TranscriptSegment {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return typeof object.start === "number" && typeof object.text === "string";
}

function formatSeconds(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}
