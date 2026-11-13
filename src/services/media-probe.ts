import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseTimecodeRate, rationalRate, type TimecodeSpec } from "../domain/clock.js";

const exec = promisify(execFile);
export async function probeFrameRate(
  path: string, choice: "from-media" | "from-media:df" | "from-media:ndf" = "from-media",
  read = async () => (await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate", "-of", "json", path], { timeout: 60_000, maxBuffer: 64 * 1024 })).stdout,
): Promise<TimecodeSpec> {
  let raw: unknown;
  try { raw = JSON.parse(await read()); } catch { throw new Error("--timecode-rate from-media requires ffprobe and a readable video stream; declare an exact rate instead."); }
  const stream = (raw as { streams?: Array<{ r_frame_rate?: unknown; avg_frame_rate?: unknown }> })?.streams?.[0];
  const parse = (value: unknown) => {
    if (typeof value !== "string" || !/^[1-9]\d*\/[1-9]\d*$/.test(value)) throw new Error("Media frame rate is missing or invalid; declare an exact rate.");
    const [num, den] = value.split("/").map(Number);
    return rationalRate(num!, den!);
  };
  const rate = parse(stream?.r_frame_rate); const average = parse(stream?.avg_frame_rate);
  if (rate.num !== average.num || rate.den !== average.den) throw new Error("Variable frame rate is not supported by --timecode-rate from-media.");
  const suffix = choice.slice("from-media".length);
  return { ...parseTimecodeRate(`${rate.num}/${rate.den}${suffix}`), rateOrigin: "media" };
}
