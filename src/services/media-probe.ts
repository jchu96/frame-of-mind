import { childEnvironment } from "../lib/child-env.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseTimecodeRate, rationalRate, type TimecodeSpec } from "../domain/clock.js";

const exec = promisify(execFile);
const timingError = "Variable frame rate or unverifiable frame timing is not supported by --timecode-rate from-media; declare an exact sequence rate instead.";
export async function probeFrameRate(
  path: string, choice: "from-media" | "from-media:df" | "from-media:ndf" = "from-media",
  read = async () => {
    const result = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate,time_base,nb_frames:frame=pts,duration,pkt_duration", "-of", "json", path], { env: childEnvironment("media"), timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    if (result.stderr.trim()) throw new Error(timingError);
    return result.stdout;
  },
): Promise<TimecodeSpec> {
  let raw: unknown;
  try { raw = JSON.parse(await read()); } catch { throw new Error("--timecode-rate from-media requires ffprobe and a complete readable video timing scan within 60 s / 32 MiB; declare an exact rate instead."); }
  const data = raw as { streams?: Array<{ r_frame_rate?: unknown; avg_frame_rate?: unknown; time_base?: unknown; nb_frames?: unknown }>; frames?: Array<{ pts?: unknown; duration?: unknown; pkt_duration?: unknown }> } | null;
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
  if (!Array.isArray(frames) || frames.length < 2) throw new Error(timingError);
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
  const suffix = choice.slice("from-media".length);
  return { ...parseTimecodeRate(`${rate.num}/${rate.den}${suffix}`), rateOrigin: "media" };
}
