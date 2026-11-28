import { exactTime, isDropRate, rationalRate, type FrameRate } from "exact-time";
import { ContractError, faultCode } from "../domain/contract-error.js";
import { RangeClock, rangeUsage, type RangeRequest } from "../domain/range-clock.js";
import { requireProof, UnprovenCut, verifyAvcSamples, type Packet } from "./avc-samples.js";
import { inspectVideo, readStartLabel, sameRate, videoHeader, type VideoInfo } from "./media-probe.js";
import { localVideoInput, runMediaTool, type Recording } from "./media-tools.js";

export function decodeBudget(seconds: number) { return Math.min(2147483647, 60000 + (Number.isFinite(seconds) && seconds > 0 ? 2000 * Math.ceil(seconds) : 0)); }
function ratio(text?: string) {
  requireProof(text && /^[1-9]\d*\/[1-9]\d*$/.test(text), "missing stream rate or time base");
  const [num, den] = text.split("/").map(Number);
  return rationalRate(num!, den!);
}
export function packetRow(row: string): Packet {
  const fields = Object.fromEntries(row.split("|").map(field => field.split("=")));
  const integer = (name: string) => {
    const text = fields[name];
    requireProof(text && /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)), "missing packet timestamps or positions");
    return Number(text);
  };
  requireProof(fields.flags && /^[K_]+$/.test(fields.flags), "discarded or corrupt packet");
  return { pts: integer("pts"), dts: integer("dts"), duration: integer("duration"), pos: integer("pos"), size: integer("size"), flags: fields.flags };
}
export function displayOrder(packets: Packet[], base: FrameRate, rate: FrameRate) {
  const ptsOrder = [...packets].sort((a,b) => a.pts - b.pts);
  const tick = BigInt(base.num) * BigInt(rate.num);
  const period = BigInt(base.den) * BigInt(rate.den);
  for (const [i, p] of ptsOrder.entries()) {
    requireProof(BigInt(p.pts) * tick === BigInt(i) * period, i === 0 ? "nonzero stream start" : "duplicate or missing presentation timestamp");
    requireProof(BigInt(p.duration) * tick === period, "variable packet duration");
    requireProof(i === 0 || packets[i]!.dts > packets[i - 1]!.dts, "ambiguous decode order");
  }
  return ptsOrder;
}

export interface SeekPlan {
  keyIndex: number; firstPts: number; endPts: number; expectedPts: number[]; timeBase: FrameRate;
  seekSeconds: string; audioHz?: number;
}
export type VideoSelection = { clock: RangeClock; info: VideoInfo; seek?: SeekPlan; reason?: string };
const packetEntries = "packet=pts,dts,duration,flags,pos,size";
const compact = "compact=p=0:nk=0";
export async function scanRange(input: Recording, request: RangeRequest, dropFrame?: boolean, signal?: AbortSignal, fallback?: (reason: string) => void): Promise<VideoSelection> {
  const header = await videoHeader(input, signal);
  const { format, video, audio, labels } = header;
  const seconds = Number(format.duration);
  try {
    requireProof(format.format_name.split(",").includes("mp4") && video.codec_name === "h264", "not progressive AVC in MP4");
    requireProof(video.field_order === "progressive", "unproved progressive picture order");
    const rate = ratio(video.r_frame_rate);
    requireProof(sameRate(rate, ratio(video.avg_frame_rate)), "unequal stream rates");
    const fileStartLabel = readStartLabel(labels, rate, dropFrame);
    const mode = dropFrame ?? fileStartLabel?.dropFrame ?? (isDropRate(rate) ? undefined : false);
    const base = ratio(video.time_base);
    const args = [...localVideoInput(format.format_name), "-select_streams", String(video.index), "-show_packets",
      "-show_entries", packetEntries, "-of", compact];
    const packets: Packet[] = [];
    await runMediaTool("ffprobe", [...args, input.path], { signal, timeoutMs: decodeBudget(seconds), onLine: line => { packets.push(packetRow(line)); } });
    requireProof(packets.length, "missing packet timestamps");
    requireProof(!video.nb_frames || video.nb_frames === "N/A" || String(packets.length) === video.nb_frames, "declared count differs from packet scan");
    const order = displayOrder(packets, base, rate);
    let clock: RangeClock | undefined, refusal: ContractError | undefined;
    try { clock = RangeClock.resolve({ rate, length: BigInt(order.length), unit: "frames", dropFrame: mode }, request); }
    catch (error) {
      if (!(error instanceof ContractError) || error.code !== "USAGE") throw error;
      // An index with split or packed pictures has not established the length
      // yet. A refusal based on it must wait for proof or a from-zero scan.
      refusal = error;
    }
    const firstIndex = Number(clock?.from ?? 0n);
    const first = order[firstIndex]!;
    const key = order.slice(0, firstIndex + 1).findLast(p => p.flags.includes("K"));
    requireProof(key, "no key before range");
    const keyIndex = order.indexOf(key);
    requireProof(!packets.some(p => p.dts >= key.dts && p.pts < key.pts), "open group at seek point");
    await verifyAvcSamples(input, Number(video.id), packets, key, signal);
    if (!clock) throw refusal!;
    // Seek requests are in microseconds. Round up to reach this key's instant.
    const us = (BigInt(key.pts) * BigInt(base.num) * 1000000n + BigInt(base.den) - 1n) / BigInt(base.den);
    const seekSeconds = `${us / 1000000n}.${String(us % 1000000n).padStart(6, "0")}`;
    const actual = await runMediaTool("ffprobe", [...args, "-read_intervals", seekSeconds + "%+#1", input.path], {signal});
    const landed = packetRow(actual.trim());
    requireProof(landed.pos === key.pos && landed.dts === key.dts && landed.pts === key.pts, "demuxer did not seek to the proven IDR");
    const info: VideoInfo = { formatName: format.format_name, duration: exactTime("source", String(order.length), rate), rate,
      dropFrame: mode, fileStartLabel, width: video.width, height: video.height, codec: video.codec_name, pixelFormat: video.pix_fmt,
      videoIndex: video.index, audio, approximateSeconds: seconds };
    const last = order[Number(clock.to - 1n)]!;
    return { clock, info, seek: { keyIndex, expectedPts: order.slice(firstIndex, Number(clock.to)).map(p => p.pts), firstPts: first.pts, endPts: last.pts + last.duration, timeBase: base, seekSeconds,
      audioHz: audio[0] ? Number(audio[0].sample_rate) : undefined } };
  } catch (error) {
    const reason = error instanceof UnprovenCut ? error.message
      : faultCode(error) === "DECODE_FAILED" ? "packet scan or IDR seek could not be verified" : undefined;
    if (!reason) throw error;
    fallback?.(reason);
    let info: VideoInfo;
    try { info = await inspectVideo(input, {dropFrame}, signal, decodeBudget(seconds)); }
    catch (error) {
      if ((error as { code?: string }).code === "INVALID_RATE") return rangeUsage("Range requires a locally verifiable cut.");
      throw error;
    }
    const clock = RangeClock.resolve({ unit: "frames", length: info.duration.frames, rate: info.rate, dropFrame: info.dropFrame }, request);
    return { info, clock, reason };
  }
}
