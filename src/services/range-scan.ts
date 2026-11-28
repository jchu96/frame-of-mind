import { exactTime, isDropRate, rationalRate, type FrameRate } from "exact-time";
import { RangeClock, rangeUsage, type RangeRequest } from "../domain/range-clock.js";
import { requireProof, UnprovenCut, verifyAvcSamples, type Packet } from "./avc-samples.js";
import { inspectVideo, readStartLabel, sameRate, videoHeader, type VideoInfo } from "./media-probe.js";
import { localVideoInput, runMediaTool, type Recording } from "./media-tools.js";

export function decodeBudget(seconds: number) { return 60000 + 2000 * Math.ceil(seconds); }
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
  key: Packet; keyIndex: number; firstPts: number; endPts: number; timeBase: FrameRate;
  seekSeconds: string; audioHz?: number;
}
export type VideoSelection = { clock: RangeClock; info: VideoInfo; seek?: SeekPlan; reason?: string };
const packetEntries = "packet=pts,dts,duration,flags,pos,size";
const compact = "compact=p=0:nk=0";
export async function scanRange(input: Recording, request: RangeRequest, dropFrame?: boolean, signal?: AbortSignal): Promise<VideoSelection> {
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
    const rows = await runMediaTool("ffprobe", [...args, input.path], { signal, timeoutMs: decodeBudget(seconds) });
    const packets = rows.trim().split("\n").map(packetRow);
    requireProof(!video.nb_frames || video.nb_frames === "N/A" || String(packets.length) === video.nb_frames, "declared count differs from packet scan");
    const order = displayOrder(packets, base, rate);
    const clock = RangeClock.resolve({ rate, length: BigInt(order.length), unit: "frames", dropFrame: mode }, request);
    const first = order[Number(clock.from)]!;
    const key = order.slice(0, Number(clock.from) + 1).findLast(p => p.flags.includes("K"));
    requireProof(key, "no key before range");
    const keyIndex = order.indexOf(key);
    requireProof(!packets.some(p => p.dts >= key.dts && p.pts < key.pts), "open group at seek point");
    await verifyAvcSamples(input, Number(video.id), packets, key, signal);
    // Seek requests are in microseconds. Round up to reach this key's instant.
    const seekSeconds = (Math.ceil(key.pts * base.num / base.den * 1e6) / 1e6).toFixed(6);
    const actual = await runMediaTool("ffprobe", [...args, "-read_intervals", seekSeconds + "%+#1", input.path], {signal});
    const landed = packetRow(actual.trim());
    requireProof(landed.pos === key.pos && landed.dts === key.dts && landed.pts === key.pts, "demuxer did not seek to the proven IDR");
    const info: VideoInfo = { formatName: format.format_name, duration: exactTime("source", String(order.length), rate), rate,
      dropFrame: mode, fileStartLabel, width: video.width, height: video.height, codec: video.codec_name, pixelFormat: video.pix_fmt,
      videoIndex: video.index, audio, approximateSeconds: seconds };
    const last = order[Number(clock.to - 1n)]!;
    return { clock, info, seek: { key, keyIndex, firstPts: first.pts, endPts: last.pts + last.duration, timeBase: base, seekSeconds,
      audioHz: audio[0] ? Number(audio[0].sample_rate) : undefined } };
  } catch (error) {
    if (!(error instanceof UnprovenCut)) throw error;
    let info: VideoInfo;
    try { info = await inspectVideo(input, {dropFrame}, signal); }
    catch (error) {
      if ((error as { code?: string }).code === "INVALID_RATE") return rangeUsage("Range requires a locally verifiable cut.");
      throw error;
    }
    const clock = RangeClock.resolve({ unit: "frames", length: info.duration.frames, rate: info.rate, dropFrame: info.dropFrame }, request);
    return { info, clock, reason: error.message };
  }
}
