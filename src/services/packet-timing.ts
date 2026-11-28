import { classifyFrameTiming, parseFrameTick, type FrameTiming } from "../domain/frame-timing.js";

interface TimingRow { type?: string; pts?: number; duration?: number; pkt_duration?: number }
interface TimingData {
  streams?: { time_base?: string }[];
  packets?: TimingRow[];
  frames?: TimingRow[];
  packets_and_frames?: TimingRow[];
}

// ffprobe interleaves the two section types when an existing decoded-frame
// proof also requests packet PTS. Only packet rows feed the rate report.
export async function readPacketTiming(read: () => Promise<string>, signal?: AbortSignal) {
  let raw: string;
  try { raw = await read(); }
  catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error) || !/timed out|exceeded its scan limit/.test(error.message)) throw error;
    return {data: undefined, frameTiming: {varying: null, frames: null, unread: "scan limit"} as const, error};
  }
  const data: TimingData = JSON.parse(raw);
  const combined = data.packets_and_frames;
  const packets = combined?.filter(row => row.type === "packet") ?? data.packets;
  if (combined) data.frames = combined.filter(row => row.type === "frame");
  let frameTiming: FrameTiming;
  if (data.streams?.length === 0) frameTiming = {varying: null, frames: 0, unread: "no picture"};
  else if (!packets || !parseFrameTick(data.streams?.[0]?.time_base)) frameTiming = {varying: null, frames: null, unread: "unavailable"};
  else frameTiming = classifyFrameTiming(packets.map(row => row.pts), parseFrameTick(data.streams?.[0]?.time_base));
  return {data, frameTiming};
}
