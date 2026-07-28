import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_TOKEN_PATH,
  FileOAuthProvider,
  OAuthCallback,
  openBrowser,
  resolveMcpEndpoint,
  secureTokenDirectory,
} from "./bluedot-oauth.js";
import type { MeetingEvidence, MediaSource } from "../domain/types.js";
import type {
  MeetingCatalogPage,
  MeetingCatalogSource,
} from "../domain/studio-ports.js";
import { findMediaUrl, firstStringForKeys } from "../lib/object.js";
import { validateBluedotMediaUrl } from "../lib/files.js";

export const DEFAULT_BLUEDOT_MCP_URL = "https://app.bluedothq.com/api/v1/mcp";
const CALLBACK_PORT = 8765;
const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

export class BluedotClient implements MeetingCatalogSource {
  readonly provider = "bluedot" as const;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private tools: Tool[] = [];

  private readonly endpoint;

  constructor(
    serverUrl = process.env.BLUEDOT_MCP_URL,
    private readonly announceAuthorization = true,
    private readonly allowAuthorization = true,
  ) {
    this.endpoint = resolveMcpEndpoint(
      "bluedot",
      serverUrl,
      DEFAULT_BLUEDOT_MCP_URL,
      DEFAULT_TOKEN_PATH,
    );
  }

  async connect(): Promise<void> {
    await secureTokenDirectory(this.endpoint.tokenPath);
    const callback = new OAuthCallback(CALLBACK_PORT, "Bluedot");
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
      if (!this.allowAuthorization) {
        throw new Error(
          "Bluedot authorization is missing or expired. Reconnect it from Local Studio before retrying.",
        );
      }
      if (!authorizationUrl) throw new Error("Bluedot did not provide an OAuth authorization URL.");
      await callback.listen();
      if (this.announceAuthorization) {
        process.stderr.write(`Authorize Bluedot in your browser:\n${authorizationUrl.toString()}\n`);
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
    const tool = this.requireTool("get_meeting");
    const args = argumentForIdentifier(tool, meetingId);
    // Bluedot currently advertises an output schema whose `duration` format
    // rejects its own ISO-8601 value. Validate the MCP envelope without applying
    // the server's inconsistent per-tool output schema.
    const result = await this.client!.request(
      { method: "tools/call", params: { name: tool.name, arguments: args } },
      CallToolResultSchema,
    );
    assertToolSucceeded(result, "Bluedot", tool.name);
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

  async search(input: {
    query?: string;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<MeetingCatalogPage> {
    if (input.signal?.aborted) {
      throw new DOMException("Catalog request canceled.", "AbortError");
    }
    const page = parseCatalogCursor(input.cursor);
    const query = input.query?.trim();
    const tool = this.requireTool(query ? "search_meetings" : "list_meetings");
    const pageSize = Math.min(input.limit, query ? 12 : 16);
    const args = query
      ? {
          query,
          page,
          pageSize,
          order: "desc",
          sortBy: "relevance",
          searchBy: ["title", "description", "transcription"],
        }
      : {
          pageNumber: page,
          pageSize,
          order: "desc",
          sortBy: "uploadedAt",
        };
    const result = await this.client!.request(
      { method: "tools/call", params: { name: tool.name, arguments: args } },
      CallToolResultSchema,
    );
    assertToolSucceeded(result, "Bluedot", tool.name);
    if (input.signal?.aborted) {
      throw new DOMException("Catalog request canceled.", "AbortError");
    }
    return normalizeBluedotCatalog(
      normalizeToolResult(result),
      pageSize,
      page,
    );
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
    this.client = new Client({ name: "frame-of-mind", version: "0.3.0" }, { capabilities: {} });
    this.transport = new StreamableHTTPClientTransport(this.endpoint.url, { authProvider: provider });
    await this.client.connect(this.transport);
  }

  private requireTool(name: string): Tool {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Bluedot MCP does not expose required tool '${name}'.`);
    return tool;
  }
}

function parseCatalogCursor(cursor: string | undefined): number {
  if (!cursor) return 1;
  if (!/^[1-9][0-9]{0,5}$/.test(cursor)) {
    throw new Error("Bluedot meeting catalog cursor is invalid.");
  }
  return Number(cursor);
}

function directString(
  object: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  const normalized = new Map(
    Object.entries(object).map(([key, value]) => [
      key.replaceAll("_", "").toLowerCase(),
      value,
    ]),
  );
  for (const name of names) {
    const value = normalized.get(name.toLowerCase());
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function meetingArrays(value: unknown, depth = 0): unknown[][] {
  if (Array.isArray(value)) return [value];
  if (!value || typeof value !== "object" || depth >= 4) return [];
  const arrays: unknown[][] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      Array.isArray(child)
      && /^(videos|meetings|recordings|results|items|data)$/i.test(key)
    ) {
      arrays.push(child);
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      arrays.push(...meetingArrays(child, depth + 1));
    }
  }
  return arrays;
}

function scalarForKeys(
  value: unknown,
  pattern: RegExp,
  depth = 0,
): unknown {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || depth >= 4
  ) {
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (pattern.test(key)) return child;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = scalarForKeys(child, pattern, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function normalizeBluedotCatalog(
  raw: unknown,
  limit: number,
  requestedPage?: number,
): MeetingCatalogPage {
  const items: MeetingCatalogPage["items"] = [];
  const seen = new Set<string>();
  for (const candidates of meetingArrays(raw)) {
    for (const candidate of candidates.slice(0, Math.max(limit * 4, 64))) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        continue;
      }
      const object = candidate as Record<string, unknown>;
      const id = directString(object, [
        "id",
        "videoid",
        "meetingid",
        "recordingid",
      ]);
      if (!id || id.length > 500 || seen.has(id)) continue;
      const titleCandidate = directString(object, [
        "title",
        "name",
        "meetingtitle",
      ]);
      const title = titleCandidate && titleCandidate.length <= 500
        ? titleCandidate
        : undefined;
      const createdAtCandidate = directString(object, [
        "uploadedat",
        "createdat",
        "datecreated",
        "recordedat",
        "starttime",
      ]);
      const createdAt = createdAtCandidate
        && Number.isFinite(Date.parse(createdAtCandidate))
        ? new Date(createdAtCandidate).toISOString()
        : undefined;
      seen.add(id);
      items.push({
        id,
        ...(title ? { title } : {}),
        ...(createdAt ? { createdAt } : {}),
      });
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }

  const hasMore = scalarForKeys(raw, /^has_?more$/i);
  const currentPageCandidate = requestedPage
    ?? scalarForKeys(raw, /^(page|page_?number)$/i);
  const currentPage = typeof currentPageCandidate === "number"
    && Number.isSafeInteger(currentPageCandidate)
    && currentPageCandidate > 0
    ? currentPageCandidate
    : 1;
  const totalPages = scalarForKeys(raw, /^total_?pages$/i);
  const more = typeof hasMore === "boolean"
    ? hasMore
    : typeof totalPages === "number" && Number.isFinite(totalPages)
      ? currentPage < totalPages
      : items.length >= limit;
  return {
    items,
    ...(more ? { nextCursor: String(currentPage + 1) } : {}),
  };
}

export function assertToolSucceeded(
  result: { isError?: boolean },
  provider: string,
  toolName: string,
): void {
  if (result.isError) {
    throw new Error(
      `${provider} MCP tool '${toolName}' failed. Verify authorization, workspace access, and the meeting ID.`,
    );
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
        if (segments.length === child.length && segments.length) return segments;
      }
      if (child && typeof child === "object" && !Array.isArray(child)) {
        const found = findTranscriptSegments(child);
        if (found.length) return found;
      }
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
