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
    const raw = extname(path).toLowerCase() === ".json" ? JSON.parse(content) as unknown : { transcript: content };
    return {
      id: meetingId,
      provider: this.provider,
      transport: "file",
      title: firstStringForKeys(raw, /^(title|name)$/i) || basename(path),
      createdAt: firstStringForKeys(raw, /^(created_?at|date|start_?time)$/i),
      summary: firstStringForKeys(raw, /^(summary|notes)$/i),
      transcript: extractTranscript(raw) || content,
      raw,
    };
  }
}
