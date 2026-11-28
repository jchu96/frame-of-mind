import { ContractError } from "../domain/contract-error.js";
import { extname } from "node:path";
import { stat } from "node:fs/promises";
import { deriveExact, exactTime, fromTicks, offsetTime, parseTimecodeRate, renderExactTimecode,
  type ExactTime } from "exact-time";
import { parseFilePosition } from "../domain/clock.js";
import { MAX_RECORDING_BYTES } from "../lib/files.js";
import { decodeVideo, inspectVideo, sameRate, type VideoInfo } from "./media-probe.js";
import { localRecording, localVideoInput, mediaWorkTimeoutMs, runMediaTool, stageOutput, type Recording } from "./media-tools.js";

type Position = ExactTime<"source">;
export type Helper = "probe" | "verify" | "proxy" | "slice" | "frame";
export interface MediaOptions {
  output?: string; force?: boolean; height?: string; allowOversize?: boolean; timecodeRate?: string;
  at?: string; from?: string; to?: string; decodeCheck?: boolean; expectFrames?: string; expectDuration?: string;
}

function tuple(t: Position) { return { clock: t.clock, frames: String(t.frames), rate: t.rate }; }
function display(t: Position, mode?: boolean) {
  const derived = deriveExact(t, mode ?? false);
  if (mode === undefined && "timecode" in derived) {
    const {timecode: _timecode, dropFrame: _mode, ...withoutLabel} = derived;
    return {...tuple(t), ...withoutLabel};
  }
  return {...tuple(t), ...derived};
}
function summary(info: VideoInfo, decodeStatus: "passed" | "unchecked") {
  const label = info.fileStartLabel;
  return { duration: display(info.duration, info.dropFrame), width: info.width, height: info.height, codec: info.codec,
    hasAudio: Boolean(info.audio.length), audio: info.audio.map(s => ({codec: s.codec_name, channels: s.channels})),
    fileStartLabel: label ? {value: tuple(label.value), dropFrame: label.dropFrame} : null, decodeStatus };
}
function position(flag: string, text: string, info: VideoInfo) {
  return parseFilePosition("source", flag, text, info.rate, info.dropFrame);
}
export function estimateProxyBytes(width: number, height: number, count: bigint, seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Missing approximate duration for proxy size estimate.");
  return Math.ceil((Number(count) * width * height * 0.08 / 8 + seconds * 64_000 / 8) * 1.02);
}
export function checkProxyBytes(bytes: number, allow: boolean, phase: "estimate" | "actual", tell: (line: string) => void) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Unusable proxy byte count.");
  if (phase === "estimate") {
    tell(`Proxy estimate: ${bytes} bytes.`);
    if (bytes > 1_800_000_000) tell("Warning: proxy estimate exceeds 1,800,000,000 bytes.");
  }
  if (bytes > MAX_RECORDING_BYTES && !allow) throw new Error(`Proxy ${phase} exceeds 2,000,000,000 bytes. Use --allow-oversize for local output.`);
}

// Perform audio edits on a PCM sample grid containing both video boundaries.
// fromTicks certifies each conversion. The final resample is only for AAC.
function audioRange(from: Position, to: Position) {
  const start = deriveExact(from, false), end = deriveExact(to, false);
  if (!("ticks" in start) || !("ticks" in end)) throw new ContractError("UNREPRESENTABLE", "Exact audio boundaries require whole ticks.");
  for (const hz of [48_000, 60_000, 96_000, 192_000]) {
    const rate = {num: hz, den: 1};
    try {
      return { hz, start: fromTicks("source", start.ticks, rate).frames, end: fromTicks("source", end.ticks, rate).frames };
    } catch (error) {
      if ((error as {code?: string}).code !== "NOT_ON_FRAME_BOUNDARY") throw error;
    }
  }
  throw new ContractError("UNREPRESENTABLE", "Video cut does not meet the supported reference-audio sample grids.");
}
function dimensions(info: VideoInfo, text = "720") {
  const height = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(height) || height % 2) throw new ContractError("INVALID_INPUT", "Height must be a positive even integer.");
  const width = 2 * Math.round(info.width * height / info.height / 2);
  if (!Number.isSafeInteger(width) || width < 2) throw new ContractError("INVALID_INPUT", "Invalid scaled width.");
  return {width, height};
}

export async function verifyStartLabel(label?: string, measuredLabel?: string, signal?: AbortSignal) {
  if (label !== measuredLabel) {
    const build = (await runMediaTool("ffmpeg", ["-version"], {signal})).split("\n")[0];
    throw new Error(`Start timecode did not round-trip: expected ${label ?? "absent"}, measured ${measuredLabel ?? "absent"} (${build}).`);
  }
}

async function encode(input: Recording, staged: string, info: VideoInfo, from: Position, to: Position,
  size: ReturnType<typeof dimensions>, signal?: AbortSignal) {
  const expected = exactTime("source", String(to.frames - from.frames), info.rate);
  const samples = audioRange(from, to);
  const audio = info.audio[0];
  const silence = `[1:a]atrim=end_sample=${samples.end - samples.start}`;
  const filter = audio
    ? `${silence}[silence];[0:${audio.index}]aresample=${samples.hz}:async=1:first_pts=0,aformat=channel_layouts=mono,atrim=start_sample=${samples.start}:end_sample=${samples.end},asetpts=PTS-STARTPTS[clip];[silence][clip]amix=duration=first:normalize=0[a]`
    : `${silence}[a]`;
  const vf = `trim=start_frame=${from.frames}:end_frame=${to.frames},setpts=PTS-STARTPTS,fps=${info.rate.num}/${info.rate.den},scale=${size.width}:${size.height}`;
  const origin = info.fileStartLabel;
  const label = origin && renderExactTimecode(offsetTime(from, origin.value), origin.dropFrame);
  await input.check();
  await runMediaTool("ffmpeg", ["-y", "-copyts", ...localVideoInput(info.formatName), "-noautorotate", "-i", input.path,
    "-f", "lavfi", "-i", `anullsrc=r=${samples.hz}:cl=mono`, "-filter_complex", filter, "-map", `0:${info.videoIndex}`,
    "-map", "[a]", "-vf", vf, "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
    "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
    "-ar", "48000", "-ac", "1", "-movflags", "+faststart", ...(label ? ["-timecode", label] : []), staged],
    {signal, timeoutMs: mediaWorkTimeoutMs(info.approximateSeconds)});

  const result = await localRecording(staged);
  const spec = {rate: info.rate, dropFrame: info.dropFrame ?? false, rateOrigin: "media"} as const;
  const out = await inspectVideo(result, spec, signal);
  await decodeVideo(result, out, signal);
  const measuredLabel = out.fileStartLabel && renderExactTimecode(out.fileStartLabel.value, out.fileStartLabel.dropFrame);
  await verifyStartLabel(label, measuredLabel, signal);
  if (out.duration.frames !== expected.frames || !sameRate(out.rate, info.rate) || out.width !== size.width
    || out.height !== size.height || out.codec !== "h264" || out.pixelFormat !== "yuv420p"
    || out.audio.length !== 1 || out.audio[0]?.codec_name !== "aac" || out.audio[0].channels !== 1) {
    throw new Error("Encoded proxy or slice differs from its expected frames, video format, or reference audio.");
  }
  return summary({...out, dropFrame: info.dropFrame}, "passed");
}

async function grab(input: Recording, staged: string, info: VideoInfo, at: Position, signal?: AbortSignal) {
  const png = extname(staged) === ".png";
  await input.check();
  await runMediaTool("ffmpeg", ["-y", ...localVideoInput(info.formatName), "-noautorotate", "-i", input.path, "-map", `0:${info.videoIndex}`,
    "-vf", `trim=start_frame=${at.frames},setpts=PTS-STARTPTS`, "-frames:v", "1", "-map_metadata", "-1",
    "-map_metadata:s", "-1", "-c:v", png ? "png" : "mjpeg", ...(png ? [] : ["-q:v", "2"]), "-f", "image2", "-update", "1", staged], {signal});
  const imageInput = ["-protocol_whitelist", "file", "-f", png ? "png_pipe" : "jpeg_pipe", "-i", staged];
  const report = JSON.parse(await runMediaTool("ffprobe", [...imageInput, "-count_frames", "-show_entries",
    "stream=codec_name,width,height,nb_read_frames", "-of", "json"], {signal}));
  const image = report.streams?.[0];
  if (report.streams?.length !== 1 || image?.nb_read_frames !== "1" || image.width !== info.width
    || image.height !== info.height || image.codec_name !== (png ? "png" : "mjpeg")) throw new Error("Staged image differs from the expected frame dimensions or codec.");
  await runMediaTool("ffmpeg", [...imageInput, "-f", "null", "-"], {signal});
  return { at: display(at, info.dropFrame), width: info.width, height: info.height, decodeStatus: "passed" };
}

export async function mediaHelper(kind: Helper, path: string, flags: MediaOptions, signal?: AbortSignal,
  tell = (line: string) => { process.stderr.write(line + "\n"); }) {
  const input = await localRecording(path);
  const declared = flags.timecodeRate;
  const declaration = declared === undefined || declared === "from-media" ? undefined
    : declared === "from-media:df" || declared === "from-media:ndf" ? {dropFrame: declared === "from-media:df"}
    : parseTimecodeRate(declared);
  const info = await inspectVideo(input, declaration, signal);
  if (kind === "probe") {
    if (flags.decodeCheck) await decodeVideo(input, info, signal);
    return {kind, ...summary(info, flags.decodeCheck ? "passed" : "unchecked")};
  }
  if (kind === "verify") {
    if ((flags.expectDuration === undefined) === (flags.expectFrames === undefined)) throw new ContractError("USAGE", "Choose exactly one of --expect-frames and --expect-duration.");
    const expected = flags.expectFrames !== undefined ? exactTime("source", flags.expectFrames, info.rate)
      : position("--expect-duration", flags.expectDuration!, info);
    await decodeVideo(input, info, signal);
    const actual = info.duration.frames;
    const mismatches = expected.frames === actual ? [] : expected.frames > actual
      ? [{ from: String(actual), to: String(expected.frames), kind: "missing" }]
      : [{ from: String(expected.frames), to: String(actual), kind: "extra" }];
    return {kind, ok: mismatches.length === 0, actual: display(info.duration, info.dropFrame), expected: display(expected, info.dropFrame), mismatches, decodeStatus: "passed"};
  }
  if (!flags.output) throw new ContractError("USAGE", "An output path is required.");
  return stageOutput(input, flags.output, kind === "frame" ? [".jpg", ".jpeg", ".png"] : [".mp4"], !!flags.force, signal, async (staged, output) => {
    if (kind === "frame") {
      const at = position("--at", flags.at!, info);
      if (at.frames >= info.duration.frames) throw new ContractError("INVALID_INPUT", "Frame lies outside the decoded video.");
      return {kind, output, ...await grab(input, staged, info, at, signal)};
    }
    const from = kind === "slice" ? position("--from", flags.from!, info) : exactTime("source", "0", info.rate);
    const to = kind === "slice" ? position("--to", flags.to!, info) : info.duration;
    if (from.frames >= to.frames || to.frames > info.duration.frames) throw new ContractError("INVALID_INPUT", "Slice requires a nonempty ordered range within the video.");
    const size = dimensions(info, flags.height);
    if (kind === "proxy") checkProxyBytes(estimateProxyBytes(size.width, size.height, info.duration.frames, info.approximateSeconds), !!flags.allowOversize, "estimate", tell);
    await decodeVideo(input, info, signal);
    const result = await encode(input, staged, info, from, to, size, signal);
    if (kind === "proxy") checkProxyBytes((await stat(staged)).size, !!flags.allowOversize, "actual", tell);
    return kind === "slice" ? {kind, ...result, output, from: display(from, info.dropFrame), to: display(to, info.dropFrame)} : {kind, ...result,
      source: { path: input.path, sizeBytes: Number(input.identity.size), mtimeMs: Number(input.identity.mtimeNs) / 1e6,
        frames: String(info.duration.frames), rate: info.rate },
      proxy: { path: output, frames: result.duration.frames, rate: result.duration.rate }, frameAligned: true };
  });
}
