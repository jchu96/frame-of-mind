import { classifyFrameTiming, parseFrameTick, type FrameTiming } from "../domain/frame-timing.js";

function wholeTick(value?: string) {
  return value && /^-?\d+$/.test(value) ? Number(value) : undefined;
}

// The compact writer labels each section and field. Collect packet PTS for the
// report and keep the decoded rows separate for the existing exact-grid proof.
export async function readPacketTiming(read: () => Promise<string>, signal?: AbortSignal) {
  let raw: string;
  try { raw = await read(); }
  catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error) || !/timed out|exceeded its scan limit/.test(error.message)) throw error;
    return {data: undefined, frameTiming: {varying: null, frames: null, unread: "scan limit"} as const, error};
  }
  const pts: (number | undefined)[] = [];
  const streams: Record<string, string>[] = [];
  const frames: {pts?: number; duration?: number}[] = [];
  for (const row of raw.split("\n")) {
    if (!row) continue;
    const [section, ...columns] = row.split("|side_data", 1)[0]!.split("|");
    const fields = Object.fromEntries(columns.map(column => column.split("=", 2)));
    if (section === "packet") pts.push(wholeTick(fields.pts));
    if (section === "frame") frames.push({pts: wholeTick(fields.pts), duration: wholeTick(fields.duration ?? fields.pkt_duration)});
    if (section === "stream") streams.push(fields);
  }
  const tick = parseFrameTick(streams[0]?.time_base);
  let frameTiming: FrameTiming;
  if (!streams.length && !pts.length) frameTiming = {varying: null, frames: 0, unread: "no picture"};
  else if (!tick) frameTiming = {varying: null, frames: null, unread: "unavailable"};
  else frameTiming = classifyFrameTiming(pts, tick);
  return {data: {streams, frames}, frameTiming};
}
