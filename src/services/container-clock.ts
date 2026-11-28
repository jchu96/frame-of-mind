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
async function sampleTimestamps(file: FileHandle, media: Element, track: Element, movie: Element, scale: number) {
  const minf = await findBox(file, media, "minf");
  const stbl = minf && await findBox(file, minf, "stbl");
  const stts = stbl && await findBox(file, stbl, "stts");
  if (!stbl || !stts) return [];
  async function* runs(box: Element, signed: boolean) {
    const header = await bytes(file, box.start, 8);
    const count = header.readUInt32BE(4);
    if (box.start + 8 + count * 8 > box.end) throw new Error("Invalid sample times.");
    for (let n = 0; n < count; ) {
      const batch = Math.min(1024, count - n);
      const rows = await bytes(file, box.start + 8 + 8*n, 8*batch);
      for (let i = 0; i < batch; i++) {
        const value = signed && header[0] === 1 ? rows.readInt32BE(i*8+4) : rows.readUInt32BE(i*8+4);
        yield {count:rows.readUInt32BE(i*8),value};
      }
      n += batch;
    }
  }
  const offsetsBox = await findBox(file, stbl, "ctts");
  const offsets = offsetsBox && runs(offsetsBox,true);
  let left = 0, offset = 0, dts = 0;
  const ticks: number[] = [];
  for await (const entry of runs(stts,false)) for (let i = 0; i < entry.count; i++) {
    if (offsets && left === 0) {
      const run = await offsets.next();
      if (run.done || run.value.count === 0) throw new Error("Invalid composition times.");
      left = run.value.count;
      offset = run.value.value;
    }
    ticks.push(dts + offset);
    dts += entry.value;
    left--;
  }
  ticks.sort((a,b) => a-b);
  const edts = await findBox(file,track,"edts");
  const elst = edts && await findBox(file,edts,"elst");
  if (!elst) return ticks.filter(t => t >= 0);
  const mvhd = await findBox(file,movie,"mvhd");
  if (!mvhd) return [];
  const head = await bytes(file,mvhd.start,Math.min(24,mvhd.end-mvhd.start));
  const movieScale = head.readUInt32BE(head[0] === 1 ? 20 : 12);
  const edits = await bytes(file,elst.start,8);
  const wide = edits[0] === 1;
  const stride = wide ? 20 : 12;
  const result: number[] = [];
  let elapsed = 0n;
  for (let i = 0; i < edits.readUInt32BE(4); i++) {
    const pos = elst.start + 8 + i*stride;
    if (pos + stride > elst.end || !movieScale) throw new Error("Invalid edit list.");
    const e = await bytes(file,pos,stride);
    const duration = wide ? e.readBigUInt64BE(0) : BigInt(e.readUInt32BE(0));
    const from = wide ? e.readBigInt64BE(8) : BigInt(e.readInt32BE(4));
    if (from >= 0n && e.readInt32BE(stride-4) === 65536) for (const t of ticks) {
      const delta = (BigInt(t)-from)*BigInt(movieScale);
      if (delta < 0n || delta >= duration*BigInt(scale)) continue;
      const value = elapsed*BigInt(scale) + delta;
      if (value % BigInt(movieScale) === 0n) result.push(Number(value/BigInt(movieScale)));
    }
    elapsed += duration;
  }
  return result;
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
    const length = !edited && duration > 0n && duration !== sentinel ? duration : undefined;
    const ticks = length === undefined ? await sampleTimestamps(file,media,track,movie,scale) : [];
    return RangeClock.wholeTicks({num:1, den:scale},length,"unproven",ticks);
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
async function unsigned(file: FileHandle, element: Element) {
  const width = element.end - element.start;
  if (width < 1 || width > 8) throw new Error("Invalid WebM integer.");
  return Number(BigInt("0x" + (await bytes(file,element.start,width)).toString("hex")));
}

async function webmVideoTrack(file: FileHandle, tracks: Element) {
  for await (const entry of ebmlElements(file,tracks.start,tracks.end)) {
    if (entry.id !== "ae") continue;
    let type, number;
    for await (const field of ebmlElements(file,entry.start,entry.end)) {
      if (field.id === "83") type = await unsigned(file,field);
      if (field.id === "d7") number = await unsigned(file,field);
    }
    if (type === 1) return number;
  }
}

async function webmTimestamps(file: FileHandle, clusters: Element[], track: number) {
  const times: number[] = [];
  for (const cluster of clusters) {
    let base: number | undefined;
    const offsets: number[] = [];
    for await (const entry of ebmlElements(file,cluster.start,cluster.end)) {
      if (entry.id === "e7") base = await unsigned(file,entry);
      const block = entry.id === "a3" ? entry : entry.id === "a0" ? await findBlock(file,entry) : undefined;
      if (!block) continue;
      const data = await bytes(file,block.start,Math.min(10,block.end-block.start));
      const width = Math.clz32(data[0] ?? 0) - 23;
      if (width > 8 || width + 2 > data.length) throw new Error("Invalid WebM block.");
      let number = data[0]! & (255 >> width);
      for (let i = 1; i < width; i++) number = number*256 + data[i]!;
      if (number === track) offsets.push(data.readInt16BE(width));
    }
    if (base !== undefined) for (const offset of offsets) if (base + offset >= 0) times.push(base + offset);
  }
  return times.sort((a,b) => a-b);
}
async function findBlock(file: FileHandle, group: Element) {
  for await (const child of ebmlElements(file,group.start,group.end)) if (child.id === "a1") return child;
}
async function webmClock(file: FileHandle, size: number) {
  for await (const segment of ebmlElements(file, 0, size)) {
    if (segment.id !== "18538067") continue;
    let track: number | undefined;
    const clusters: Element[] = [];
    let scale: number | undefined;
    for await (const element of ebmlElements(file, segment.start, segment.end)) {
      if (element.id === "1654ae6b") track = await webmVideoTrack(file, element);
      if (element.id === "1f43b675") clusters.push(element);
      if (element.id === "1549a966") {
        scale = 1_000_000; // WebM default TimestampScale, in nanoseconds.
        for await (const field of ebmlElements(file, element.start, element.end)) {
          if (field.id !== "2ad7b1") continue;
          if (field.end - field.start > 8 || field.end === field.start) throw new Error("Invalid WebM timestamp scale.");
          scale = Number(BigInt("0x" + (await bytes(file, field.start, field.end - field.start)).toString("hex")));
        }
      }
    }
    if (track !== undefined && scale !== undefined) return RangeClock.wholeTicks(rationalRate(scale,1_000_000_000),
      undefined,"unproven",await webmTimestamps(file,clusters,track));
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
