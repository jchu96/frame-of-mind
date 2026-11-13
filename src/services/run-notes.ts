import { open } from "node:fs/promises";
import { extname } from "node:path";
import { sha256Text } from "../lib/files.js";
import { MAX_RUN_NOTE_BYTES, MAX_RUN_NOTES, RUN_NOTE_NAME, type RunNote } from "../domain/run-notes.js";

/** Read bounded UTF-8 reference data before any provider work. Bodies stay in memory. */
export async function loadRunNotes(entries: readonly string[] = []): Promise<RunNote[]> {
  if (entries.length > MAX_RUN_NOTES) throw new Error("Use at most 8 run notes.");
  const names = new Set<string>();
  const inputs = entries.map((entry) => {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    const path = entry.slice(separator + 1);
    if (separator < 1 || !path || !RUN_NOTE_NAME.test(name)) {
      throw new Error("--note must be name=path with a lowercase note name of at most 32 characters.");
    }
    if (names.has(name)) throw new Error("Run note names must be unique.");
    names.add(name);
    if (![".txt", ".md", ".markdown"].includes(extname(path).toLowerCase())) {
      throw new Error("Run notes must be UTF-8 text or Markdown files.");
    }
    return { name, path };
  });
  const notes: RunNote[] = [];
  for (const { name, path } of inputs) {
    const file = await open(path, "r");
    let buffer: Buffer;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new Error("Run notes must be regular files.");
      if (metadata.size > MAX_RUN_NOTE_BYTES) throw new Error("A run note may not exceed 64 KiB.");
      buffer = Buffer.alloc(MAX_RUN_NOTE_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await file.read(buffer, bytes, buffer.length - bytes, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > MAX_RUN_NOTE_BYTES) throw new Error("A run note may not exceed 64 KiB.");
      buffer = buffer.subarray(0, bytes);
    } finally { await file.close(); }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { throw new Error("Run notes must contain valid UTF-8 text."); }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
      throw new Error("Run notes must contain text, not binary data.");
    }
    notes.push({ name, text, sha256: sha256Text(text), bytes: buffer.length });
  }
  return notes;
}
