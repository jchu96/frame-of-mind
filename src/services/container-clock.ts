// Whole-file analysis can run without local media tools. Read only container
// metadata from the named file in that case. The clock stays unproven.
import { open, type FileHandle } from "node:fs/promises";
import { rationalRate } from "exact-time";
import { RangeClock } from "../domain/range-clock.js";
import type { Recording } from "./media-tools.js";

async function bytes(file: FileHandle, at: number, length: number) {
  const data = Buffer.alloc(length);
  for (let n = 0; n < length;) {
    const read = await file.read(data, n, length - n, at + n);
    if (!read.bytesRead) throw new Error("Truncated container header.");
    n += read.bytesRead;
  }
  return data;
}

interface Element { id: string; start: number; end: number }
async function* mp4Boxes(file: FileHandle, at: number, end: number): AsyncGenerator<Element> {
  while (at + 8 <= end) {
    const header = await bytes(file, at, 8);
    const size32 = header.readUInt32BE();
    const size = size32 === 1 ? Number((await bytes(file, at + 8, 8)).readBigUInt64BE()) : size32 || end - at;
    const start = at + (size32 === 1 ? 16 : 8);
    if (!Number.isSafeInteger(size) || start > at + size || at + size > end) throw new Error("Invalid movie box.");
    yield {id: header.toString("ascii", 4, 8), start, end: at + size};
    at += size;
  }
}
async function findBox(file: FileHandle, parent: Element, id: string) {
  for await (const child of mp4Boxes(file, parent.start, parent.end)) if (child.id === id) return child;
}
async function movieClock(file: FileHandle, size: number) {
  const movie = await findBox(file, {id:"", start:0, end:size}, "moov");
  if (!movie) return;
  for await (const track of mp4Boxes(file, movie.start, movie.end)) {
    if (track.id !== "trak") continue;
    const media = await findBox(file, track, "mdia");
    if (!media) continue;
    const handler = await findBox(file, media, "hdlr");
    if (!handler || handler.end - handler.start < 12 || (await bytes(file, handler.start + 8, 4)).toString() !== "vide") continue;
    const header = await findBox(file, media, "mdhd");
    if (!header) continue;
    const data = await bytes(file, header.start, Math.min(header.end - header.start, 32));
    if (data[0] !== 0 && data[0] !== 1) continue;
    const scale = data.readUInt32BE(data[0] === 1 ? 20 : 12);
    if (!scale) continue;
    // mdhd duration is on the media timeline. An edit can move or
    // shorten the presentation, so leave the playable length unknown.
    const duration = data[0] === 1 ? data.readBigUInt64BE(24) : BigInt(data.readUInt32BE(16));
    const sentinel = data[0] === 1 ? 0xffffffffffffffffn : 0xffffffffn;
    const edited = await findBox(file, track, "edts");
    return RangeClock.wholeTicks({num:1, den:scale}, !edited && duration > 0n && duration !== sentinel ? duration : undefined, "unproven");
  }
}

async function* ebmlElements(file: FileHandle, at: number, end: number): AsyncGenerator<Element> {
  while (at < end) {
    const header = await bytes(file, at, Math.min(12, end - at));
    let pos = 0;
    function vint(isId: boolean) {
      const first = header[pos++] ?? 0;
      const width = Math.clz32(first) - 23;
      if (width > (isId ? 4 : 8) || pos + width - 1 > header.length) throw new Error("Invalid WebM header.");
      let value = BigInt(isId ? first : first & (255 >> width));
      for (let i = 1; i < width; i++) value = (value << 8n) + BigInt(header[pos++]!);
      return !isId && value === (1n << BigInt(7 * width)) - 1n ? undefined : value;
    }
    const id = vint(true)!.toString(16);
    const size = vint(false);
    const start = at + pos;
    const next = size === undefined ? end : start + Number(size);
    if (!Number.isSafeInteger(next) || next > end) throw new Error("Invalid WebM element.");
    yield {id, start, end:next};
    at = next;
  }
}
async function webmHasVideo(file: FileHandle, tracks: Element) {
  for await (const entry of ebmlElements(file, tracks.start, tracks.end)) {
    if (entry.id !== "ae") continue;
    for await (const field of ebmlElements(file, entry.start, entry.end)) {
      if (field.id === "83" && field.end - field.start === 1 && (await bytes(file, field.start, 1))[0] === 1) return true;
    }
  }
  return false;
}

async function webmClock(file: FileHandle, size: number) {
  for await (const segment of ebmlElements(file, 0, size)) {
    if (segment.id !== "18538067") continue;
    let video = false;
    let scale: number | undefined;
    for await (const element of ebmlElements(file, segment.start, segment.end)) {
      if (element.id === "1654ae6b") video = await webmHasVideo(file, element);
      if (element.id === "1549a966") {
        scale = 1_000_000; // WebM default TimestampScale, in nanoseconds.
        for await (const field of ebmlElements(file, element.start, element.end)) {
          if (field.id !== "2ad7b1") continue;
          if (field.end - field.start > 8 || field.end === field.start) throw new Error("Invalid WebM timestamp scale.");
          scale = Number(BigInt("0x" + (await bytes(file, field.start, field.end - field.start)).toString("hex")));
        }
      }
      if (video && scale !== undefined) return RangeClock.wholeTicks(rationalRate(scale, 1_000_000_000), undefined, "unproven");
    }
  }
}

export async function containerVideoClock(input: Recording) {
  const file = await open(input.path, "r");
  try {
    const stat = await file.stat({bigint:true});
    if (stat.dev !== input.identity.dev || stat.ino !== input.identity.ino) throw new Error("Recording changed.");
    const size = Number(stat.size);
    const magic = await bytes(file, 0, 4);
    const clock = magic.readUInt32BE() === 0x1a45dfa3 ? await webmClock(file, size) : await movieClock(file, size);
    await input.check();
    return clock;
  } finally {
    await file.close();
  }
}
