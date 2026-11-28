import { rationalRate } from "exact-time";
import { isRanged, enforceRangeLimit } from "../lib/range-policy.js";
export { isRanged, maxRangeSeconds } from "../lib/range-policy.js";
import { ContractError, faultCode } from "../domain/contract-error.js";
import { RangeClock, rangeUsage, type RangeRequest } from "../domain/range-clock.js";
import { containerVideoClock } from "./container-clock.js";
import { audioGrid, recordingTracks, runRecordingTool, withAudioRange } from "./audio-range.js";
import { localRecording } from "./media-tools.js";
import { measureTiming } from "./media-probe.js";
import { decodeBudget } from "./range-scan.js";
import { withVideoRange } from "./video-range.js";

export interface SourceOptions extends RangeRequest { timecodeRate?: string; signal?: AbortSignal; onSourceResolved?: (clock: RangeClock) => void }
export async function withSourceRecording<T>(path: string, options: SourceOptions, needs: "audio" | "video",
  tell: (line: string) => void, consume: (file: string, clock: RangeClock, hasAudio?: boolean) => Promise<T>) {
  const source = await localRecording(path);
  const {signal} = options;
  const ranged = isRanged(options);
  const beforeCut = (clock: RangeClock) => {
    options.onSourceResolved?.(clock);
    enforceRangeLimit(clock);
  };
  let tracks: Awaited<ReturnType<typeof recordingTracks>>;
  try {
    tracks = await recordingTracks(source, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (!["DECODE_FAILED", "INVALID_RATE", "CAPABILITY_MISSING"].includes(faultCode(error))) throw error;
    if (ranged) return rangeUsage("Range requires a locally verifiable cut.");
    if (needs === "video") {
      const clock = await containerVideoClock(source);
      if (clock) {
        options.onSourceResolved?.(clock);
        return consume(path, clock);
      }
    }
    throw error;
  }
  if (needs === "audio" && !tracks.audio) throw new ContractError("DECODE_FAILED", "The recording has no audio track.");
  if (needs === "video" && !tracks.video) {
    const native = !ranged && await containerVideoClock(source);
    if (native) {
      options.onSourceResolved?.(native);
      return consume(path, native, Boolean(tracks.audio));
    }
    throw new ContractError("INVALID_INPUT", "Analysis requires a video stream.");
  }
  const mode = options.timecodeRate === "from-media:df" ? true : options.timecodeRate === "from-media:ndf" ? false : undefined;
  if (ranged) {
    if (needs === "audio" && options.timecodeRate !== undefined && mode === undefined) return rangeUsage("Invalid range bound.");
    return tracks.video ? withVideoRange(path, options, mode, tell, signal, (file, s) => consume(file, s.clock, Boolean(tracks.audio)), s => beforeCut(s.clock))
      : withAudioRange(path, options, tell, signal, consume, beforeCut);
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
      if (!["USAGE", "INVALID_RATE", "INVALID_TIMECODE", "DECODE_FAILED", "COMMAND_FAILED"].includes(faultCode(error))) throw error;
      const timeBase = /^(\d+)\/(\d+)$/.exec(tracks.video.time_base ?? "");
      if (!timeBase) {
        const native = await containerVideoClock(source);
        if (!native) throw error;
        options.onSourceResolved?.(native);
        return consume(path, native, Boolean(tracks.audio));
      }
      const tick = rationalRate(Number(timeBase[1]), Number(timeBase[2]));
      const length = tracks.video.duration_ts;
      const varying = tracks.video.r_frame_rate && tracks.video.avg_frame_rate && tracks.video.r_frame_rate !== tracks.video.avg_frame_rate;
      clock = RangeClock.wholeTicks(tick, Number.isSafeInteger(length) && length! > 0 ? BigInt(length!) : undefined, varying ? "varying" : "unproven");
    }
  } else {
    clock = RangeClock.resolve(await audioGrid(source, tracks.audio!, tracks.seconds, signal), {});
  }
  await source.check();
  options.onSourceResolved?.(clock);
  return consume(path, clock, Boolean(tracks.audio));
}
