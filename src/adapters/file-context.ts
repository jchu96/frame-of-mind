import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { MeetingContextSource, MeetingEvidence } from "../domain/types.js";
import { firstStringForKeys } from "../lib/object.js";
import { exactSpanSchema } from "../domain/source-bound.js";
import { extractTranscript, findTranscriptSegments } from "./bluedot-mcp.js";

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
    const cues = extension === ".srt" || extension === ".vtt" ? captionCues(content)
      : findTranscriptSegments(raw).map(segment => {
        const exact = exactSpanSchema.safeParse(segment.exactSpan);
        return {startMs:Math.round(segment.start*1000), ...(typeof segment.end === "number" && {endMs:Math.round(segment.end*1000)}),
          text:`${segment.speakerTag || segment.speaker || "Unknown speaker"}: ${segment.text}`, ...(exact.success && {exactSpan:exact.data})};
      });
    return {
      ...(cues.length && {transcriptCues:cues}),
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

function captionCues(content: string) {
  const milliseconds = (stamp: string) => {
    const fields = stamp.replace(",", ".").split(":").map(Number);
    return Math.round(fields.reduce((n, part) => n * 60 + part, 0) * 1000);
  };
  return content.replace(/^\uFEFF/,"").split(/\r?\n\s*\r?\n/).flatMap(block => {
    const lines = block.split(/\r?\n/);
    const i = lines.findIndex(line => line.includes("-->"));
    const cue = /^(\d{2,}(?::\d{2}){1,2}[.,]\d{3})\s+-->\s+(\d{2,}(?::\d{2}){1,2}[.,]\d{3})/.exec(lines[i] ?? "");
    if (!cue) return [];
    return [{startMs:milliseconds(cue[1]!),endMs:milliseconds(cue[2]!),text:lines.slice(i+1).map(s => s.replace(/<[^>]+>/g,"").trim()).filter(Boolean).join(" ")}];
  });
}
