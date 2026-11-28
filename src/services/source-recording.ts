import { rationalRate } from "exact-time";
import { isRanged, maxRangeSeconds } from "../lib/range-policy.js";
export { isRanged, maxRangeSeconds } from "../lib/range-policy.js";
import { ContractError, faultCode } from "../domain/contract-error.js";
import { RangeClock, rangeUsage, type RangeRequest } from "../domain/range-clock.js";
import { audioGrid, recordingTracks, runRecordingTool, withAudioRange } from "./audio-range.js";
import { localRecording } from "./media-tools.js";
import { measureTiming } from "./media-probe.js";
import { decodeBudget } from "./range-scan.js";
import { withVideoRange } from "./video-range.js";

function checkLimit(clock: RangeClock) {
  const limitSeconds = maxRangeSeconds();
  if ((clock.to - clock.from) * BigInt(clock.grid.rate.den) > BigInt(limitSeconds) * BigInt(clock.grid.rate.num)) {
    throw new ContractError("RECORDING_TOO_LONG", "The selected range exceeds the recording duration limit.",
      {durationSeconds: clock.elapsed(clock.to - clock.from), limitSeconds});
  }
}

export interface SourceOptions extends RangeRequest { timecodeRate?: string; signal?: AbortSignal }
export async function withSourceRecording<T>(path: string, options: SourceOptions, needs: "audio" | "video",
  tell: (line: string) => void, consume: (file: string, clock: RangeClock) => Promise<T>) {
  const source = await localRecording(path);
  const {signal} = options;
  const tracks = await recordingTracks(source, signal);
  if (needs === "audio" && !tracks.audio) throw new ContractError("DECODE_FAILED", "The recording has no audio track.");
  if (needs === "video" && !tracks.video) throw new ContractError("INVALID_INPUT", "Analysis requires a video stream.");
  const mode = options.timecodeRate === "from-media:df" ? true : options.timecodeRate === "from-media:ndf" ? false : undefined;
  if (isRanged(options)) {
    if (needs === "audio" && options.timecodeRate !== undefined && mode === undefined) return rangeUsage("Invalid range bound.");
    return tracks.video ? withVideoRange(path, options, mode, tell, signal, (file, s) => consume(file, s.clock), s => checkLimit(s.clock))
      : withAudioRange(path, options, tell, signal, consume, checkLimit);
  }
  let clock: RangeClock;
  if (tracks.video) {
    try {
      const frames = await runRecordingTool(source, "ffprobe", ["-select_streams", String(tracks.video.index), "-count_frames",
        "-show_entries", "stream=r_frame_rate,avg_frame_rate,time_base,nb_frames,nb_read_frames:frame=pts,duration,pkt_duration",
        "-of", "json", "fd:"], {signal, timeoutMs:decodeBudget(tracks.seconds)});
      const {rate, count} = measureTiming(JSON.parse(frames), undefined, true);
      clock = RangeClock.resolve({unit:"frames", rate, length:BigInt(count)}, {});
    }
    catch (error) {
      signal?.throwIfAborted();
      if (!["USAGE", "INVALID_RATE", "INVALID_TIMECODE", "DECODE_FAILED"].includes(faultCode(error))) throw error;
      const timeBase = /^(\d+)\/(\d+)$/.exec(tracks.video.time_base ?? "");
      if (!timeBase) throw error;
      const tick = rationalRate(Number(timeBase[1]), Number(timeBase[2]));
      const length = tracks.video.duration_ts;
      const varying = tracks.video.r_frame_rate && tracks.video.avg_frame_rate && tracks.video.r_frame_rate !== tracks.video.avg_frame_rate;
      clock = RangeClock.wholeTicks(tick, Number.isSafeInteger(length) && length! > 0 ? BigInt(length!) : undefined, varying ? "varying" : "unproven");
    }
  } else {
    clock = RangeClock.resolve(await audioGrid(source, tracks.audio!, tracks.seconds, signal), {});
  }
  await source.check();
  return consume(path, clock);
}
