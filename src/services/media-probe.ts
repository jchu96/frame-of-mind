import { resolve } from "node:path";
import { z } from "zod";
import { exactTime, fromTimecode, isDropRate, parseTimecodeRate, rationalRate, type ExactTime, type FrameRate, type TimecodeSpec } from "exact-time";
import { localVideoInput, runMediaTool, type Recording } from "./media-tools.js";

const timingError = "Variable frame rate or unverifiable frame timing is not supported by --timecode-rate from-media; declare an exact sequence rate instead.";
export async function probeFrameRate(
  path: string, choice: "from-media" | "from-media:df" | "from-media:ndf" = "from-media",
  read = () => readTiming(resolve(path), "v:0"),
): Promise<TimecodeSpec> {
  let raw: unknown;
  try { raw = JSON.parse(await read()); } catch { throw new Error("--timecode-rate from-media requires ffprobe and a complete readable video timing scan within 60 s / 32 MiB; declare an exact rate instead."); }
  const { rate } = measureTiming(raw);
  const suffix = choice.slice("from-media".length);
  return { ...parseTimecodeRate(`${rate.num}/${rate.den}${suffix}`), rateOrigin: "media" };
}

function readTiming(path: string, selector: string, signal?: AbortSignal) {
  return runMediaTool("ffprobe", [...localVideoInput, "-select_streams", selector, "-count_frames",
    "-show_entries", "stream=r_frame_rate,avg_frame_rate,time_base,nb_frames,nb_read_frames:frame=pts,duration,pkt_duration",
    "-of", "json", path], {signal});
}
function measureTiming(raw: unknown, independentRate?: FrameRate, requireCount = false) {
  const data = raw as { streams?: Array<{ r_frame_rate?: unknown; avg_frame_rate?: unknown; time_base?: unknown; nb_frames?: unknown; nb_read_frames?: unknown }>; frames?: Array<{ pts?: unknown; duration?: unknown; pkt_duration?: unknown }> } | null;
  const stream = data?.streams?.[0];
  const parse = (value: unknown) => {
    if (typeof value !== "string" || !/^[1-9]\d*\/[1-9]\d*$/.test(value)) throw new Error("Media frame rate is missing or invalid; declare an exact rate.");
    const [num, den] = value.split("/").map(Number);
    return rationalRate(num!, den!);
  };
  const rate = parse(stream?.r_frame_rate); const average = parse(stream?.avg_frame_rate);
  if (rate.num !== average.num || rate.den !== average.den) throw new Error("Variable frame rate is not supported by --timecode-rate from-media.");
  // Summary rates can agree even when one frame is delayed. Verify every
  // presentation boundary and duration in integer stream ticks, from file zero.
  // Quantized/absent timestamps cannot establish exact CFR and are refused.
  const timeBase = parse(stream?.time_base);
  const frames = data?.frames;
  if (!Array.isArray(frames) || !frames.length) throw new Error(timingError);
  if (frames.length === 1 && (!independentRate || !sameRate(rate, independentRate))) {
    throw new Error("One-frame timing requires an independently specified matching rate.");
  }
  if (requireCount && stream?.nb_read_frames !== String(frames.length)) throw new Error(timingError);
  if (stream?.nb_frames !== undefined && stream.nb_frames !== "N/A"
    && String(frames.length) !== stream.nb_frames) throw new Error(timingError);
  const tick = BigInt(timeBase.num) * BigInt(rate.num);
  const period = BigInt(timeBase.den) * BigInt(rate.den);
  for (const [index, frame] of frames.entries()) {
    const pts = frame?.pts;
    const duration = frame?.duration ?? frame?.pkt_duration;
    if (typeof pts !== "number" || !Number.isSafeInteger(pts)
      || typeof duration !== "number" || !Number.isSafeInteger(duration)
      || BigInt(pts) * tick !== BigInt(index) * period
      || BigInt(duration) * tick !== period) throw new Error(timingError);
  }
  return { rate, count: String(frames.length) };
}

export function sameRate(a: FrameRate, b: FrameRate) { return a.num === b.num && a.den === b.den; }

const tags = z.record(z.string(), z.string()).optional();
const streamsSchema = z.object({
  streams: z.array(z.object({
    index: z.number().int().nonnegative(), codec_type: z.string(), codec_name: z.string().optional(),
    codec_tag_string: z.string().optional(), width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(), channels: z.number().int().positive().optional(),
    pix_fmt: z.string().optional(), tags, disposition: z.object({ attached_pic: z.number() }).optional(),
  })),
  format: z.object({ duration: z.string().optional(), tags }),
});

type StartLabel = { value: ExactTime<"source">; dropFrame: boolean };
export function readStartLabel(values: string[], rate: FrameRate, statedMode?: boolean): StartLabel | undefined {
  const unique = [...new Set(values)];
  if (unique.length > 1) throw new Error("Conflicting file start timecode labels.");
  const label = unique[0];
  if (label === undefined) return undefined;
  const dropFrame = statedMode ?? label.includes(";");
  return { value: fromTimecode("source", label, rate, dropFrame), dropFrame };
}
function tagValues(metadata: Record<string,string> | undefined) {
  return Object.entries(metadata ?? {}).filter(([key]) => key.toLowerCase() === "timecode").map(([,value]) => value);
}

export interface VideoInfo {
  duration: ExactTime<"source">;
  rate: FrameRate;
  dropFrame?: boolean;
  fileStartLabel?: StartLabel;
  width: number;
  height: number;
  codec: string;
  pixelFormat?: string;
  videoIndex: number;
  audio: {index: number; codec_name?: string; channels?: number}[];
  approximateSeconds: number;
}

export async function inspectVideo(input: Recording, declaration?: {rate?: FrameRate; dropFrame?: boolean}, signal?: AbortSignal): Promise<VideoInfo> {
  await input.check();
  const json = await runMediaTool("ffprobe", [...localVideoInput, "-show_entries",
    "stream=index,codec_type,codec_name,codec_tag_string,width,height,channels,pix_fmt:stream_disposition=attached_pic:stream_tags=timecode:format=duration:format_tags=timecode",
    "-of", "json", input.path], {signal});
  const {streams, format} = streamsSchema.parse(JSON.parse(json));
  const videos = streams.filter(s => s.codec_type === "video" && !s.disposition?.attached_pic);
  const video = videos[0];
  if (!video?.width || !video.height || !video.codec_name) throw new Error("Missing primary video dimensions or codec.");
  const audio = streams.filter(s => s.codec_type === "audio");
  if (audio.some(s => !s.channels || !s.codec_name)) throw new Error("Missing audio codec or channel count.");
  const tracks = streams.filter(s => s.codec_tag_string === "tmcd");
  if (tracks.length && videos.length !== 1) throw new Error("Ambiguous association between video and timecode tracks.");
  const labels = [format, video, ...tracks].flatMap(s => tagValues(s.tags));
  await input.check();
  const {rate, count} = measureTiming(JSON.parse(await readTiming(input.path, String(video.index), signal)), declaration?.rate, true);
  if (declaration?.rate && !sameRate(rate, declaration.rate)) throw new Error("Declared rate differs from measured video rate.");
  const fileStartLabel = readStartLabel(labels, rate, declaration?.dropFrame);
  const dropFrame = declaration?.dropFrame ?? fileStartLabel?.dropFrame ?? (isDropRate(rate) ? undefined : false);
  if (dropFrame && !isDropRate(rate)) throw new Error("Drop-frame mode requires 30000/1001 or 60000/1001.");
  await input.check();
  return { duration: exactTime("source", count, rate), rate, dropFrame, fileStartLabel,
    width: video.width, height: video.height, codec: video.codec_name, pixelFormat: video.pix_fmt,
    videoIndex: video.index, audio, approximateSeconds: Number(format.duration) };
}


export async function decodeVideo(input: Recording, info: VideoInfo, signal?: AbortSignal) {
  await input.check();
  try {
    await runMediaTool("ffmpeg", [...localVideoInput, "-i", input.path, "-map", `0:${info.videoIndex}`,
      ...info.audio.flatMap(s => ["-map", `0:${s.index}`]), "-f", "null", "-"], {signal});
  } catch (cause) {
    throw new DecodeError(cause instanceof Error ? cause.message : "Full media decode failed.", {cause});
  }
  await input.check();
}

export class DecodeError extends Error {}
