import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_GRANOLA_TOKEN_PATH,
  FileOAuthProvider,
  OAuthCallback,
  openBrowser,
  resolveMcpEndpoint,
  secureTokenDirectory,
} from "./bluedot-oauth.js";
import type { MeetingEvidence } from "../domain/types.js";
import { firstStringForKeys } from "../lib/object.js";
import { normalizeToolResult } from "./bluedot-mcp.js";

export const DEFAULT_GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";
const CALLBACK_PORT = 8766;
const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

export class GranolaClient {
  readonly provider = "granola" as const;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private tools: Tool[] = [];

  private readonly endpoint;

  constructor(
    serverUrl = process.env.GRANOLA_MCP_URL,
    private readonly announceAuthorization = true,
  ) {
    this.endpoint = resolveMcpEndpoint(
      "granola",
      serverUrl,
      DEFAULT_GRANOLA_MCP_URL,
      DEFAULT_GRANOLA_TOKEN_PATH,
    );
  }

  async connect(): Promise<void> {
    await secureTokenDirectory(this.endpoint.tokenPath);
    const callback = new OAuthCallback(CALLBACK_PORT, "Granola");
    let authorizationUrl: URL | undefined;
    const provider = new FileOAuthProvider(
      CALLBACK_URL,
      this.endpoint.tokenPath,
      (url) => { authorizationUrl = url; },
      callback.state,
      this.endpoint.url.toString(),
      this.endpoint.canonical,
    );
    try {
      await this.attemptConnection(provider);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      if (!authorizationUrl) throw new Error("Granola did not provide an OAuth authorization URL.");
      await callback.listen();
      if (this.announceAuthorization) {
        process.stderr.write(`Authorize Granola in your browser:\n${authorizationUrl.toString()}\n`);
      }
      await openBrowser(authorizationUrl);
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
    const details = await this.callMeetingTool("get_meetings", meetingId);
    const transcript = await this.callMeetingTool("get_meeting_transcript", meetingId);
    const combined = { details, transcript };
    return {
      id: firstStringForKeys(details, /^(meeting_?id|note_?id|id)$/i) || meetingId,
      provider: this.provider,
      transport: "mcp",
      title: firstStringForKeys(details, /^(title|name|meeting_?title)$/i),
      createdAt: firstStringForKeys(details, /^(created_?at|date|start_?time|meeting_?date)$/i),
      sourceUrl: firstStringForKeys(details, /^(web_?url|url)$/i),
      summary: firstStringForKeys(details, /^(summary|summary_?text|enhanced_?notes)$/i),
      transcript: extractGranolaTranscript(transcript),
      raw: combined,
    };
  }

  private async callMeetingTool(name: string, meetingId: string): Promise<unknown> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      const planHint = name === "get_meeting_transcript"
        ? " Granola limits transcript access by plan; use --source file with an exported transcript if this tool is unavailable."
        : "";
      throw new Error(`Granola MCP does not expose required tool '${name}'.${planHint}`);
    }
    const args = granolaArguments(tool, meetingId);
    const result = await this.client!.request(
      { method: "tools/call", params: { name: tool.name, arguments: args } },
      CallToolResultSchema,
    );
    if (result.isError) {
      throw new Error(
        `Granola MCP tool '${name}' failed. Verify authorization, workspace policy, plan access, and the meeting ID.`,
      );
    }
    return normalizeToolResult(result);
  }

  private async attemptConnection(provider: FileOAuthProvider): Promise<void> {
    this.client = new Client({ name: "frame-of-mind", version: "0.2.1" }, { capabilities: {} });
    this.transport = new StreamableHTTPClientTransport(this.endpoint.url, { authProvider: provider });
    await this.client.connect(this.transport);
  }
}

export function granolaArguments(tool: Tool, value: string): Record<string, unknown> {
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties || {};
  const keys = Object.keys(properties);
  const preferred = [
    "meeting_ids",
    "meetingIds",
    "note_ids",
    "noteIds",
    "meeting_id",
    "meetingId",
    "note_id",
    "noteId",
    "id",
  ];
  const key = preferred.find((candidate) => candidate in properties) || keys[0];
  if (!key) throw new Error(`Tool '${tool.name}' has no meeting identifier argument.`);
  const schema = properties[key] as { type?: string } | undefined;
  return { [key]: schema?.type === "array" || key.endsWith("s") ? [value] : value };
}

export function extractGranolaTranscript(raw: unknown): string {
  const entries = findTranscriptEntries(raw);
  if (entries.length) {
    const absoluteTimes = entries.map((entry) => Date.parse(entry.startTime || "")).filter(Number.isFinite);
    const origin = absoluteTimes.length ? Math.min(...absoluteTimes) : undefined;
    return entries.map((entry) => {
      const label = entry.speakerLabel || entry.speakerSource || "Unknown speaker";
      const stamp = entry.startTime && origin !== undefined
        ? formatSeconds((Date.parse(entry.startTime) - origin) / 1000)
        : undefined;
      return `${stamp ? `[${stamp}] ` : ""}${label}: ${entry.text}`;
    }).join("\n");
  }
  const direct = firstStringForKeys(raw, /^(transcript|raw_?transcript)$/i);
  if (direct) return direct;
  return "";
}

interface GranolaTranscriptEntry {
  text: string;
  startTime?: string;
  speakerLabel?: string;
  speakerSource?: string;
}

function findTranscriptEntries(value: unknown): GranolaTranscriptEntry[] {
  if (Array.isArray(value)) {
    const entries = value.map(toTranscriptEntry).filter((entry): entry is GranolaTranscriptEntry => Boolean(entry));
    if (entries.length === value.length && entries.length) return entries;
    for (const child of value) {
      const found = findTranscriptEntries(child);
      if (found.length) return found;
    }
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = findTranscriptEntries(child);
      if (found.length) return found;
    }
  }
  return [];
}

function toTranscriptEntry(value: unknown): GranolaTranscriptEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.text !== "string") return undefined;
  const speaker = object.speaker && typeof object.speaker === "object"
    ? object.speaker as Record<string, unknown>
    : {};
  return {
    text: object.text,
    ...(typeof object.start_time === "string" ? { startTime: object.start_time } : {}),
    ...(typeof speaker.diarization_label === "string" ? { speakerLabel: speaker.diarization_label } : {}),
    ...(typeof speaker.source === "string" ? { speakerSource: speaker.source } : {}),
  };
}

function formatSeconds(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}
