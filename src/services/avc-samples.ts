// The seek path accepts a deliberately narrow, independently checkable subset:
// one avc1 description, progressive pictures and one complete slice per MP4 sample.
// Other valid encodings remain readable by the from-zero decoder.
import { open, type FileHandle } from "node:fs/promises";
import type { Recording } from "./media-tools.js";

export class UnprovenCut extends Error {}
export function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new UnprovenCut(reason);
}
export interface Packet { pts: number; dts: number; duration: number; pos: number; size: number; flags: string }

async function read(file: FileHandle, position: number, bytes: number) {
  const out = Buffer.alloc(bytes);
  let count = 0;
  while (count < bytes) {
    const { bytesRead } = await file.read(out, count, bytes - count, position + count);
    requireProof(bytesRead, "truncated MP4");
    count += bytesRead;
  }
  return out;
}
function boxes(data: Buffer, offset = 0) {
  const result: { type: string; data: Buffer }[] = [];
  while (offset < data.length) {
    requireProof(offset + 8 <= data.length, "invalid MP4 box");
    const size = data.readUInt32BE(offset);
    requireProof(size >= 8 && offset + size <= data.length, "unsupported MP4 box");
    result.push({ type: data.toString("latin1", offset + 4, offset + 8), data: data.subarray(offset + 8, offset + size) });
    offset += size;
  }
  return result;
}
function box(data: Buffer, name: string, offset = 0) {
  const matches = boxes(data, offset).filter(e => e.type === name);
  requireProof(matches.length === 1, `unproved MP4 ${name} table`);
  return matches[0]!.data;
}
async function movie(file: FileHandle, size: number) {
  for (let pos = 0; pos + 8 <= size;) {
    const header = await read(file, pos, Math.min(16, size - pos));
    const word = header.readUInt32BE();
    const length = word === 1 ? Number(header.readBigUInt64BE(8)) : word || size - pos;
    const prefix = word === 1 ? 16 : 8;
    requireProof(Number.isSafeInteger(length) && length >= prefix && length <= size - pos, "invalid MP4 length");
    if (header.toString("latin1", 4, 8) === "moov") {
      requireProof(length <= 32 * 1024 * 1024, "MP4 sample tables exceed scan limit");
      return read(file, pos + prefix, length - prefix);
    }
    pos += length;
  }
  throw new UnprovenCut("missing MP4 movie header");
}

class Bits {
  private position = 0;
  private readonly data: number[] = [];
  constructor(nal: Buffer) {
    for (let i = 1; i < nal.length; i++) {
      if (i > 2 && nal[i - 2] === 0 && nal[i - 1] === 0 && nal[i] === 3) continue;
      this.data.push(nal[i]!);
    }
  }
  uint(width: number) {
    requireProof(this.position + width <= this.data.length * 8, "incomplete AVC header");
    let result = 0;
    for (let i = 0; i < width; i++, this.position++) {
      result = result * 2 + ((this.data[this.position >> 3]! >> (7 - this.position % 8)) & 1);
    }
    return result;
  }
  ue() {
    let bits = 0;
    while (!this.uint(1)) requireProof(++bits < 31, "unsupported AVC header value");
    return 2 ** bits - 1 + this.uint(bits);
  }
}
function parameterSets(config: Buffer) {
  requireProof(config[0] === 1 && (config[5]! & 31) === 1, "unproved AVC parameter sets");
  const width = (config[4]! & 3) + 1;
  const spsEnd = 8 + config.readUInt16BE(6);
  requireProof(config[8] === 0x67 && config[spsEnd] === 1, "unproved AVC sequence header");
  const s = new Bits(config.subarray(8, spsEnd));
  const profile = s.uint(8);
  s.uint(16);
  const sps = s.ue();
  if (profile === 100) {
    requireProof(s.ue() === 1 && s.ue() === 0 && s.ue() === 0, "unsupported AVC chroma or depth");
    s.uint(1);
    requireProof(!s.uint(1), "unsupported AVC scaling matrix");
  } else requireProof(profile === 66 || profile === 77, "unsupported AVC profile");
  const frameBits = s.ue() + 4;
  const pocMode = s.ue();
  requireProof(frameBits <= 16 && (pocMode === 0 || pocMode === 2), "unproved AVC picture order");
  const pocBits = pocMode === 0 ? s.ue() + 4 : 0;
  requireProof(pocBits <= 16, "unsupported AVC order field");
  s.ue();
  requireProof(!s.uint(1), "AVC frame number gaps permitted");
  s.ue(); s.ue();
  requireProof(s.uint(1), "field-coded AVC");
  const ppsStart = spsEnd + 3;
  const p = new Bits(config.subarray(ppsStart, ppsStart + config.readUInt16BE(spsEnd + 1)));
  requireProof((config[ppsStart]! & 31) === 8, "unproved AVC picture header");
  const pps = p.ue();
  requireProof(p.ue() === sps, "inconsistent AVC parameter sets");
  p.uint(1);
  const bottomOrder = p.uint(1);
  requireProof(!bottomOrder && p.ue() === 0, "unproved AVC picture layout");
  p.ue(); p.ue(); p.uint(3); p.ue(); p.ue(); p.ue(); p.uint(1); p.uint(1);
  requireProof(!p.uint(1), "redundant AVC pictures");
  return { width, frameBits, pocBits, pps };
}

function sampleTable(movie: Buffer, trackId: number, packets: Packet[]) {
  const track = boxes(movie).find(entry => {
    if (entry.type !== "trak") return false;
    const tk = box(entry.data, "tkhd");
    return tk.readUInt32BE(tk[0] === 1 ? 20 : 12) === trackId;
  })?.data;
  requireProof(track, "primary track missing from MP4");
  requireProof(!boxes(track).some(x => x.type === "edts"), "MP4 edit list");
  const stbl = box(box(box(track, "mdia"), "minf"), "stbl");
  const desc = box(stbl, "stsd");
  requireProof(desc.readUInt32BE(4) === 1, "changing sample description");
  const config = parameterSets(box(box(desc, "avc1", 8), "avcC", 78));
  const sizes = box(stbl, "stsz");
  const fixed = sizes.readUInt32BE(4);
  requireProof(sizes.readUInt32BE(8) === packets.length, "sample count mismatch");
  const table = box(stbl, "stsc");
  const offsets = boxes(stbl).find(x => x.type === "stco" || x.type === "co64");
  requireProof(offsets && table.readUInt32BE(8) === 1, "missing chunk offsets");
  const runs = table.readUInt32BE(4);
  let sample = 0, run = 0;
  for (let chunk = 1; chunk <= offsets.data.readUInt32BE(4); chunk++) {
    if (run + 1 < runs && table.readUInt32BE(20 + run * 12) === chunk) run++;
    const n = table.readUInt32BE(12 + run * 12);
    requireProof(n > 0 && table.readUInt32BE(16 + run * 12) === 1, "unsupported sample description");
    let pos = offsets.type === "stco" ? offsets.data.readUInt32BE(8 + (chunk - 1) * 4) : Number(offsets.data.readBigUInt64BE(8 + (chunk - 1) * 8));
    for (let i = 0; i < n; i++, sample++) {
      const p = packets[sample];
      const size = fixed || sizes.readUInt32BE(12 + sample * 4);
      requireProof(p && p.pos === pos && p.size === size, "packet differs from MP4 sample");
      pos += size;
    }
  }
  requireProof(sample === packets.length, "incomplete MP4 sample table");
  return config;
}

export async function verifyAvcSamples(input: Recording, trackId: number, packets: Packet[], key: Packet, signal?: AbortSignal) {
  const file = await open(input.path, "r");
  try {
    const size = Number(input.identity.size);
    const config = sampleTable(await movie(file, size), trackId, packets);
    let previous = "", base = -1, cached: Buffer = Buffer.alloc(0);
    // Cache sequential header reads. Large picture payloads need no entropy decoding.
    const prefix = async (pos: number, n: number) => {
      if (pos < base || pos + n > base + cached.length) {
        cached = await read(file, pos, Math.min(size - pos, 64 * 1024));
        base = pos;
      }
      return cached.subarray(pos - base, pos - base + n);
    };
    for (const pkt of packets) {
      signal?.throwIfAborted();
      let picture = "";
      for (let pos = pkt.pos; pos < pkt.pos + pkt.size;) {
        const bytes = await prefix(pos, Math.min(64, pkt.pos + pkt.size - pos));
        const length = bytes.readUIntBE(0, config.width);
        const nal = bytes.subarray(config.width, config.width + length);
        requireProof(length > 0 && pos + config.width + length <= pkt.pos + pkt.size && (nal[0]! & 128) === 0, "invalid AVC sample");
        pos += config.width + length;
        const kind = nal[0]! & 31;
        if (kind === 9 || kind === 12) continue;
        if (kind === 6) {
          // Only unregistered user data (e.g. encoder identification); picture timing
          // SEI can repeat a field or picture. Refuse additional payloads.
          const sei = await read(file, pos - length, Math.min(length, 65536));
          let at = 2, payload = 0;
          requireProof(sei[1] === 5 && sei.length === length, "unproved AVC SEI");
          while (sei[at] === 255) { payload += 255; at++; }
          payload += sei[at++]!;
          requireProof(at + payload + 1 === length && sei[length - 1] === 128, "unproved AVC SEI");
          continue;
        }
        requireProof(!picture && (kind === 1 || kind === 5), "packed pictures or changing AVC headers");
        const bits = new Bits(nal);
        requireProof(bits.ue() === 0, "split AVC picture");
        requireProof(bits.ue() <= 9 && bits.ue() === config.pps, "unknown AVC picture parameters");
        const frame = bits.uint(config.frameBits);
        const id = kind === 5 ? bits.ue() : -1;
        const order = bits.uint(config.pocBits);
        picture = [kind, !!(nal[0]! & 96), frame, id, order].join("/");
        if (pkt === key) requireProof(kind === 5, "open group at seek point");
      }
      requireProof(picture && picture !== previous, "missing or split AVC picture");
      previous = picture;
    }
    await input.check();
  } catch (error) {
    if (error instanceof RangeError) throw new UnprovenCut("truncated MP4 or AVC header");
    throw error;
  } finally { await file.close(); }
}
