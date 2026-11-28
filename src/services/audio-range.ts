import { open } from "node:fs/promises";
import { join } from "node:path";
import { createScratch, rangeEncoder, releaseRangeScratch } from "../adapters/scratch.js";
import { RangeClock, rangeUsage, type RangeRequest } from "../domain/range-clock.js";
import { ContractError } from "../domain/contract-error.js";
import { localRecording, runMediaTool, type Recording } from "./media-tools.js";
import { requireProof } from "./avc-samples.js";
import { decodeBudget } from "./range-scan.js";

const audioFormats = ["-protocol_whitelist", "fd", "-format_whitelist", "mov,matroska,webm,avi,wav,aiff,flac,mp3,ogg,aac"];
const unverified = () => rangeUsage("Range requires a locally verifiable cut.");
interface AudioHeader {
  index: number; codec_type: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; sample_rate?: string; time_base?: string;
  duration_ts?: number; start_pts?: number; disposition?: { attached_pic?: number };
}

// The decoder can open only the inherited recording descriptor; embedded
// playlists and external MOV data references cannot acquire another file.
export async function runRecordingTool(input: Recording, binary: string, args: string[], options: Parameters<typeof runMediaTool>[2]) {
  await input.check();
  const file = await open(input.path, "r");
  try {
    const stat = await file.stat({bigint: true});
    if (stat.ino !== input.identity.ino || stat.dev !== input.identity.dev) throw new ContractError("CONFLICT", "Input recording changed.");
    return await runMediaTool(binary, [...audioFormats, ...args], {...options, inputFd: file.fd});
  } finally { await file.close(); }
}

export async function recordingTracks(input: Recording, signal?: AbortSignal) {
  const raw = await runRecordingTool(input, "ffprobe", [ "-show_entries",
    "stream=index,codec_type,width,height,r_frame_rate,avg_frame_rate,sample_rate,time_base,duration_ts,start_pts:stream_disposition=attached_pic:format=duration", "-of", "json", "fd:"], {signal});
  const data = JSON.parse(raw) as {streams: AudioHeader[]; format?: {duration?: string}};
  if (!Array.isArray(data?.streams)) throw new ContractError("DECODE_FAILED", "Unable to read stream metadata.");
  return { video: data.streams.find(s => s.codec_type === "video" && !s.disposition?.attached_pic),
    audio: data.streams.find(s => s.codec_type === "audio"), seconds: Number(data.format?.duration) };
}

export function checkPcmTrace(trace: string, hz: number, start: bigint, end?: bigint) {
  const lines = trace.trim().split("\n");
  if (!lines.some(line => line.trim() === `#tb 0: 1/${hz}`)) return unverified();
  let next = start;
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const fields = line.split(",").map(x => x.trim());
    if (fields[0] !== "0" || !/^-?\d+$/.test(fields[2] ?? "") || !/^\d+$/.test(fields[3] ?? "")) return unverified();
    if (BigInt(fields[2]!) !== next || BigInt(fields[3]!) < 1n) return unverified();
    next += BigInt(fields[3]!);
  }
  if (next === start || (end !== undefined && next !== end)) return unverified();
  return next;
}

// If the demuxer cannot give an exact native-sample length, count decoded
// PCM and verify continuity. Never derive N by rounding format.duration.
export async function audioGrid(input: Recording, track: AudioHeader, seconds: number, signal?: AbortSignal) {
  const hz = Number(track.sample_rate);
  if (!Number.isSafeInteger(hz) || hz < 1) return unverified();
  const tb = /^(\d+)\/(\d+)$/.exec(track.time_base ?? "");
  let length: bigint | undefined;
  if (tb && Number.isSafeInteger(track.duration_ts) && track.duration_ts! > 0) {
    const scaled = BigInt(track.duration_ts!) * BigInt(tb[1]!) * BigInt(hz);
    if (BigInt(tb[2]!) > 0n && scaled % BigInt(tb[2]!) === 0n) length = scaled / BigInt(tb[2]!);
  }
  if (length === undefined) {
    const trace = await runRecordingTool(input, "ffmpeg", ["-copyts", "-start_at_zero", "-i", "fd:",
      "-map", `0:${track.index}`, "-c:a", "pcm_f64le", "-f", "framecrc", "pipe:1"], { signal, timeoutMs: decodeBudget(seconds) });
    length = checkPcmTrace(trace, hz, 0n);
  }
  return { unit: "samples" as const, rate: { num: hz, den: 1 }, length };
}

export async function withAudioRange<T>(path: string, request: RangeRequest, tell: (line: string) => void, signal: AbortSignal | undefined,
  consume: (path: string, clock: RangeClock) => Promise<T>, beforeCut?: (clock: RangeClock) => void) {
  const input = await localRecording(path);
  let range = `${request.from ?? "0"},${request.to ?? "EOF"}`, phase = "reading audio clock";
  const progress = () => tell(`Cutting source [${range}): seek — ${phase}`);
  progress();
  const timer = setInterval(progress, 30000);
  timer.unref();
  const dir = await createScratch("range").catch(error => { clearInterval(timer); throw error; });
  try {
    const tracks = await recordingTracks(input, signal);
    if (!tracks.audio) throw new ContractError("DECODE_FAILED", "The recording has no audio track.");
    if (tracks.video) return unverified();
    const grid = await audioGrid(input, tracks.audio, tracks.seconds, signal);
    const clock = RangeClock.resolve(grid, request);
    tell(clock.rangeLine());
    beforeCut?.(clock);
    range = `${clock.from},${clock.to}`;
    phase = "trimming native PCM";
    progress();
    const file = join(dir, "cut.wav");
    await (await open(file, "wx", 0o600)).close();
    const registered = rangeEncoder(file);
    const hz = grid.rate.num;
    const seek = Math.max(0, Number(clock.from) / hz - 2);
    const duration = Number(clock.to) / hz - seek + 1;
    const trace = await runRecordingTool(input, "ffmpeg", ["-y", "-copyts", "-start_at_zero", "-ss", seek.toFixed(6),
      "-t", duration.toFixed(6), "-i", "fd:",
      "-filter_complex", `[0:${tracks.audio.index}]asettb=1/${hz},atrim=start_pts=${clock.from}:end_pts=${clock.to},asplit[trace][cut];[cut]asetpts=PTS-STARTPTS[out]`,
      "-map", "[trace]", "-c:a", "pcm_f64le", "-f", "framecrc", "pipe:1",
      "-map", "[out]", "-map_metadata", "-1", "-c:a", "pcm_f64le", "-rf64", "auto", file],
      {signal, onSpawn: registered, timeoutMs: decodeBudget(duration)});
    checkPcmTrace(trace, hz, clock.from, clock.to);
    phase = "verifying PCM cut"; progress();
    const result = await runMediaTool("ffmpeg", ["-i", file, "-map", "0:a:0", "-c:a", "pcm_f64le", "-f", "framecrc", "pipe:1"],
      {signal, timeoutMs: decodeBudget(Number(clock.to - clock.from) / hz)});
    checkPcmTrace(result, hz, 0n, clock.to - clock.from);
    await input.check();
    signal?.throwIfAborted();
    clearInterval(timer);
    return await consume(file, clock);
  } finally { clearInterval(timer); await releaseRangeScratch(dir); }
}

// AAC decoders may expose a padded last access unit. The container's playable
// duration excludes that padding; verify it and decode every playable sample.
export async function verifyCutAudio(file: Recording, count: bigint, signal?: AbortSignal) {
  const tracks = await recordingTracks(file, signal);
  requireProof(tracks.audio?.time_base === "1/48000" && tracks.audio.sample_rate === "48000" && tracks.audio.start_pts === 0
    && Number.isSafeInteger(tracks.audio.duration_ts) && BigInt(tracks.audio.duration_ts!) === count, "AAC playable sample span differs from the cut");
  const trace = await runRecordingTool(file, "ffmpeg", ["-copyts", "-i", "fd:", "-map", "0:a:0",
    "-c:a", "pcm_s16le", "-f", "framecrc", "pipe:1"], {signal, timeoutMs: decodeBudget(Number(count) / 48000)});
  const decoded = checkPcmTrace(trace, 48000, 0n);
  requireProof(decoded >= count && decoded - count < 1024n, "AAC priming or padding differs from its playable span");
}
