import { ContractError } from "../domain/contract-error.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { deriveExact, isDropRate, parseTimecodeRate, rationalRate, renderExactTimecode, TICKS_PER_SECOND, type ExactTime } from "exact-time";
import { z } from "zod";
import { sameRate } from "../domain/media-clock.js";
import { localRecording } from "./media-tools.js";

export async function boundedJson(path: string, limit: number, kind: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new ContractError("INVALID_INPUT", `${kind} must be a regular file.`);
    const tooLarge = () => new ContractError("INVALID_INPUT", `${kind} exceeds the ${limit}-byte limit.`);
    if (stat.size > limit) throw tooLarge();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of file.createReadStream({ end: limit, autoClose: false })) {
      bytes += chunk.length;
      if (bytes > limit) throw tooLarge();
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ContractError("INVALID_INPUT", `Invalid JSON in ${kind}.`); }
  } finally { await file.close(); }
}

const sidecarSchema = z.object({
  sequence: z.object({ name: z.string(), ticksPerFrame: z.string().regex(/^[1-9]\d*$/),
    displayFormatCode: z.number(), dropFrame: z.boolean().nullable(), zeroPointTicks: z.string().regex(/^(0|[1-9]\d*)$/) }),
});

function ticks(time: ExactTime) {
  const forms = deriveExact(time, false);
  return "ticks" in forms ? forms.ticks : undefined;
}

function sidecarMode(raw: unknown, origin: ExactTime) {
  const result = sidecarSchema.safeParse(raw);
  if (!result.success) throw new Error("invalid sequence sidecar fields");
  const { ticksPerFrame, dropFrame, zeroPointTicks } = result.data.sequence;
  const grid = Number(ticksPerFrame);
  if (!Number.isSafeInteger(grid)) throw new Error("ticks per frame do not identify an accepted rate");
  const rate = rationalRate(Number(TICKS_PER_SECOND), grid);
  if (!sameRate(rate, origin.rate)) {
    const named = ["23.976", "24", "25", "29.97ndf", "30", "47.952", "48", "50", "59.94ndf", "60"];
    if (!named.some(spec => sameRate(parseTimecodeRate(spec).rate, rate))) {
      throw new Error("ticks per frame do not identify an accepted rate for this timeline");
    }
    throw new Error("sidecar rate differs from timeline rate");
  }
  if (ticks(origin) !== zeroPointTicks) throw new Error("sidecar zero point differs from timeline start");
  if (dropFrame === null) throw new Error("sidecar dropFrame is unknown");
  if (dropFrame && !isDropRate(rate)) throw new Error("sidecar dropFrame is invalid for timeline rate");
  return dropFrame;
}

// Tokenize only the embedded XML. Quoted attributes, comments and CDATA may
// themselves contain markup. None of those is a startTimecode element.
function packetFormats(xml: string) {
  const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  const stack: string[] = [];
  const formats: string[] = [];
  for (const [tag] of xml.matchAll(markup)) {
    if (tag.startsWith("<?") || tag.startsWith("<!")) continue;
    const [, closing, element] = /^<(\/?)([\w.:-]+)/.exec(tag) ?? [];
    if (!element) throw new Error("invalid metadata element");
    if (closing) {
      if (stack.pop() !== element) throw new Error("invalid metadata nesting");
      continue;
    }
    if (!tag.endsWith("/>")) stack.push(element);
    if (element !== "xmpDM:startTimecode") continue;
    const attrs = [...tag.matchAll(/\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)];
    const fields = attrs.filter(([, key]) => key === "xmpDM:timeFormat");
    if (fields.length !== 1) throw new Error("missing or ambiguous startTimecode timeFormat");
    formats.push(fields[0]![2] ?? fields[0]![3]!);
  }
  if (stack.length) throw new Error("incomplete metadata packet");
  return formats;
}

async function videoMode(path: string, origin: ExactTime) {
  const input = await localRecording(path);
  const file = await open(input.path, "r");
  const envelopes = [
    { begin: "<?xpacket begin", end: "<?xpacket end", tail: "?>" },
    { begin: "<x:xmpmeta", end: "</x:xmpmeta>", tail: "" },
    { begin: "<rdf:RDF", end: "</rdf:RDF>", tail: "" },
  ];
  let packet: typeof envelopes[number] | undefined;
  const formats = new Set<string>();
  let buffer = "";
  try {
    for await (const chunk of file.createReadStream({ autoClose: false, encoding: "latin1" })) {
      buffer += chunk;
      for (;;) {
        if (!packet) {
          const start = buffer.search(/<\?xpacket begin|<x:xmpmeta(?=[\s>])|<rdf:RDF(?=[\s>])/);
          if (start < 0) { buffer = buffer.slice(-16); break; }
          buffer = buffer.slice(start);
          packet = envelopes.find(p => buffer.startsWith(p.begin))!;
        }
        const close = buffer.indexOf(packet.end);
        const tail = close < 0 ? -1 : buffer.indexOf(packet.tail, close + packet.end.length);
        if (tail < 0 && buffer.length <= 1_048_576) break;
        if (tail < 0 || tail > 1_048_576) throw new Error("metadata packet exceeds 1 MiB");
        const next = tail + packet.tail.length;
        for (const format of packetFormats(buffer.slice(0, next))) formats.add(format);
        buffer = buffer.slice(next);
        packet = undefined;
      }
    }
    await input.check();
  } finally { await file.close(); }
  if (packet) throw new Error("incomplete metadata packet");
  if (formats.size !== 1) throw new Error("startTimecode timeFormat is absent or ambiguous");
  if (!sameRate(origin.rate, parseTimecodeRate("29.97ndf").rate)) throw new Error("unverified video timeFormat at this rate");
  const [format] = formats;
  if (format === "2997DropTimecode") return true;
  if (format === "2997NonDropTimecode") return false;
  throw new Error("unsupported startTimecode timeFormat");
}

export type SequenceMode = { dropFrame?: boolean; basis: string; notes: string[] };
export async function sequenceMode(path: string, origin: ExactTime, flag?: string, video?: string): Promise<SequenceMode> {
  const notes: string[] = [];
  if (flag !== undefined) {
    const spec = parseTimecodeRate(flag);
    if (!sameRate(spec.rate, origin.rate)) throw new ContractError("INVALID_RATE", "--timecode-rate differs from the timeline rate.");
    return { dropFrame: spec.dropFrame, basis: "flag", notes };
  }
  try {
    const raw = await boundedJson(path + ".sequence.json", 65_536, "sequence sidecar");
    return { dropFrame: sidecarMode(raw, origin), basis: "sidecar", notes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") notes.push(`Sidecar ignored: ${(error as Error).message}`);
  }
  if (video) {
    try { return { dropFrame: await videoMode(video, origin), basis: "video", notes }; }
    catch (error) { notes.push(`Exported video ignored: ${(error as Error).message}`); }
  }
  return isDropRate(origin.rate) ? { basis: "unknown", notes } : { dropFrame: false, basis: "rate", notes };
}

export function timecodeLabel(time: ExactTime, dropFrame: boolean) {
  const label = renderExactTimecode(time, dropFrame);
  return { mode: dropFrame ? "drop-frame" : "non-drop", timecode: label };
}
