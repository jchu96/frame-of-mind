import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { MeetingContextSource, MeetingEvidence } from "../domain/types.js";
import { firstStringForKeys } from "../lib/object.js";
import { extractTranscript } from "./bluedot-mcp.js";

export class FileContextSource implements MeetingContextSource {
  readonly provider = "file" as const;

  constructor(private readonly path: string) {}

  async connect(): Promise<void> {}

  async close(): Promise<void> {}

  async meeting(meetingId: string): Promise<MeetingEvidence> {
    const path = resolve(this.path);
    const content = await readFile(path, "utf8");
    const extension = extname(path).toLowerCase();
    const transcript = extension === ".srt" || extension === ".vtt"
      ? parseCaptionTranscript(content)
      : content;
    const raw = extension === ".json" ? JSON.parse(content) as unknown : { transcript };
    const extractedTranscript = extractTranscript(raw);
    return {
      id: meetingId,
      provider: this.provider,
      transport: "file",
      title: firstStringForKeys(raw, /^(title|name)$/i) || basename(path),
      createdAt: firstStringForKeys(raw, /^(created_?at|date|start_?time)$/i),
      summary: firstStringForKeys(raw, /^(summary|notes)$/i),
      transcript: extractedTranscript || (extension === ".json" ? "" : transcript),
      raw,
    };
  }
}

export function parseCaptionTranscript(content: string): string {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(
      /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[,.]\d{3}\s+-->\s+/,
    );
    if (!match) continue;
    const timestamp = [
      match[1] || "00",
      match[2],
      match[3],
    ].map((part) => String(part).padStart(2, "0")).join(":");
    const text: string[] = [];
    for (index += 1; index < lines.length && lines[index]?.trim(); index += 1) {
      text.push(lines[index]!.replace(/<[^>]+>/g, "").trim());
    }
    const cue = text.filter(Boolean).join(" ");
    if (cue) output.push(`[${timestamp}] ${cue}`);
  }
  return output.join("\n");
}
