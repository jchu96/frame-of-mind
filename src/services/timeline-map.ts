import { ContractError } from "../domain/contract-error.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exactTime, offsetTime, type ExactTime, type FrameRate } from "exact-time";
import { sameRate } from "../domain/media-clock.js";
import { parseTimelinePosition } from "../domain/clock.js";
import { contains, difference, readTimeline, type Segment, type Timeline, type Transition, type VideoTrack } from "../domain/otio-map.js";
import { probeStartLabel } from "./media-probe.js";
import { localRecording } from "./media-tools.js";
import { boundedJson, sequenceMode, timecodeLabel, type SequenceMode } from "./timeline-metadata.js";

type Position = ExactTime<"timeline">;
export interface MapOptions { at?: string; source?: string; frame?: string; track?: string; timecodeRate?: string; video?: string }
type Location = { track: number; trackName: string };
type SequencePosition = { sequenceFrame: string; sequenceTimecodes: ReturnType<typeof timecodeLabel>[] };
type Result =
  | { status: "source"; clock: "source"; clip: string; path: string; fileValue: string; mediaFrame: string; sourceTimecode?: string; sourceTimecodeReason?: string }
  | { status: "transition"; clips: string[] }
  | { status: "gap" }
  | { status: "nested" | "refused"; clip: string; reason: string };
type Row = Location & Partial<SequencePosition> & Result;

function localPath(target: string, base: string) {
  if (/^file:/i.test(target)) {
    const url = new URL(target);
    if (url.hostname && url.hostname !== "localhost") throw new ContractError("INVALID_INPUT", "network media references are unsupported");
    target = fileURLToPath(url);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) throw new ContractError("INVALID_INPUT", "media reference is not a local path");
  if (/^(?:\\\\|\/\/)/.test(target)) throw new ContractError("INVALID_INPUT", "network media references are unsupported");
  return resolve(base, target);
}

async function readTag(path: string, rate: FrameRate) {
  try {
    const input = await localRecording(path);
    const label = await probeStartLabel(input, rate);
    return label ? { label } : { reason: "file has no timecode tag" };
  } catch (error) {
    return { reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing source file" : "source timecode could not be verified" };
  }
}

function sequencePosition(time: Position, timeline: Timeline, mode: SequenceMode): SequencePosition {
  const labelTime = offsetTime(time, timeline.origin);
  const modes = mode.dropFrame === undefined ? [false, true] : [mode.dropFrame];
  return { sequenceFrame: String(time.frames), sequenceTimecodes: modes.map(df => timecodeLabel(labelTime, df)) };
}

function transitionResult(transition: Transition): Result {
  return { status: "transition", clips: [transition.left.item.name, transition.right.item.name] };
}

type TagReader = (path: string, rate: FrameRate) => ReturnType<typeof readTag>;
async function segmentResult(segment: Segment, time: Position, base: string, tag: TagReader): Promise<Result> {
  const { item } = segment;
  if (item.kind === "gap") return { status: "gap" };
  if (item.kind === "nested") return { status: "nested", clip: item.name, reason: "nested sequence, not resolved" };
  const refuse = (reason: string): Result => ({ status: "refused", clip: item.name, reason });
  if (item.kind !== "clip") return refuse("unsupported track item");
  if (item.refusal || !item.available || !item.target) return refuse(item.refusal ?? "missing media reference");
  const file = offsetTime(difference(time, segment.start), item.range.start);
  if (!contains(item.available, file)) return refuse("source frame outside available_range");
  let path: string;
  try { path = localPath(item.target, base); }
  catch { return refuse("unsupported local media path"); }
  const source = await tag(path, file.rate);
  const reading = source.label?.value.frames === item.available.start.frames
    ? { sourceTimecode: timecodeLabel(file, source.label.dropFrame).timecode.replaceAll(":", source.label.dropFrame ? ";" : ":") }
    : { sourceTimecodeReason: source.reason ?? "file timecode tag disagrees with available_range start" };
  return { status: "source", clock: "source", clip: item.name, path, fileValue: String(file.frames),
    mediaFrame: String(difference(file, item.available.start).frames), ...reading };
}

function selectedTracks(timeline: Timeline, selector?: string) {
  if (selector === undefined) return timeline.tracks;
  if (!/^[1-9]\d*$/.test(selector)) throw new ContractError("INVALID_INPUT", "--track requires a positive video track number.");
  const selected = timeline.tracks.filter(t => String(t.number) === selector);
  if (!selected.length) throw new ContractError("INVALID_INPUT", `Video track ${selector} has no included items.`);
  return selected;
}

async function reverse(track: VideoTrack, path: string, frame: string, base: string, tag: TagReader,
  position: (t: Position) => SequencePosition): Promise<Row[]> {
  const rows: Row[] = [];
  const location = { track: track.number, trackName: track.name };
  const seen = new Set<bigint>();
  for (const segment of track.segments) {
    const { item } = segment;
    if (item.kind === "nested" || item.kind === "unsupported") {
      rows.push({ ...location, status: item.kind === "nested" ? "nested" : "refused", clip: item.name,
        reason: item.kind === "nested" ? "nested sequence, not resolved" : "unsupported track item" });
      continue;
    }
    if (item.kind !== "clip" || !item.target) continue;
    let target: string;
    try { target = localPath(item.target, base); } catch { continue; }
    if (target !== path) continue;
    const file = exactTime("source", frame, item.range.start.rate);
    if (item.available && sameRate(item.available.start.rate, file.rate) && !contains(item.available, file)) continue;
    if (item.refusal) {
      rows.push({ ...location, status: "refused", clip: item.name, reason: item.refusal });
      continue;
    }
    // Add before subtracting so a transition can use source handles before
    // the incoming clip's trim without manufacturing a negative timestamp.
    const shifted = offsetTime(file, segment.start);
    const trim = exactTime("timeline", String(item.range.start.frames), item.range.start.rate);
    if (shifted.frames < trim.frames) continue;
    const time = difference(shifted, trim);
    const transition = track.transitions.find(t => (t.left === segment || t.right === segment) && contains(t, time));
    if (!transition && !contains(segment, time)) continue;
    if (seen.has(time.frames)) continue;
    seen.add(time.frames);
    const result = transition ? transitionResult(transition) : await segmentResult(segment, time, base, tag);
    rows.push({ ...location, ...position(time), ...result });
  }
  return rows;
}

export async function mapTimeline(path: string, options: MapOptions) {
  const forward = options.at !== undefined;
  if (forward ? options.source !== undefined || options.frame !== undefined : !options.source || !options.frame) {
    throw new ContractError("USAGE", "Use --at <time> or --source <path> with --frame <file value>.");
  }
  const timeline = readTimeline(await boundedJson(path, 16_777_216, "timeline export"));
  const tracks = selectedTracks(timeline, options.track);
  const mode = await sequenceMode(path, timeline.origin, options.timecodeRate, options.video);
  const base = dirname(resolve(path));
  const position = (t: Position) => sequencePosition(t, timeline, mode);
  const cache = new Map<string, ReturnType<typeof readTag>>();
  const tag: TagReader = (path, rate) => {
    const key = JSON.stringify([path, rate]);
    const result = cache.get(key) ?? readTag(path, rate);
    cache.set(key, result);
    return result;
  };
  const rows: Row[] = [];
  const common = { rate: timeline.origin.rate, mode, rows };
  if (options.at !== undefined) {
    const { time, absolute } = parseTimelinePosition(options.at, timeline.origin, mode.dropFrame);
    if (absolute && time.frames < timeline.origin.frames) return { ...common, status: "outside the sequence" };
    const at = absolute ? difference(time, timeline.origin) : time;
    if (at.frames >= timeline.duration.frames) return { ...common, ...position(at), status: "outside the sequence" };
    for (const track of tracks) {
      const transition = track.transitions.find(t => contains(t, at));
      const segment = track.segments.find(s => contains(s, at));
      if (!segment) continue;
      const result = transition ? transitionResult(transition) : await segmentResult(segment, at, base, tag);
      rows.push({ track: track.number, trackName: track.name, ...result });
    }
    return { ...common, ...position(at), status: rows.length ? "mapped" : "no video source" };
  }
  const frame = options.frame!;
  exactTime("source", frame, timeline.origin.rate); // validate even if the path never occurs
  const source = localPath(options.source!, process.cwd());
  for (const track of tracks) rows.push(...await reverse(track, source, frame, base, tag, position));
  return { ...common, status: rows.length ? "matches or unresolved items" : "no source occurrence" };
}

function renderPosition(frame?: string, labels?: SequencePosition["sequenceTimecodes"]) {
  return frame === undefined ? "" : `sequence frame ${frame} (${labels?.map(l => `${l.timecode} ${l.mode}`).join(", ")})`;
}
export function describeMap(output: Awaited<ReturnType<typeof mapTimeline>>) {
  const lines = [...output.mode.notes];
  if ("sequenceFrame" in output) lines.push(renderPosition(output.sequenceFrame, output.sequenceTimecodes));
  for (const row of output.rows) {
    let detail: string;
    switch (row.status) {
      case "source": detail = `${row.clip} · ${row.path} · file value ${row.fileValue} · media frame ${row.mediaFrame} · ${row.sourceTimecode ? "source timecode " + row.sourceTimecode : row.sourceTimecodeReason}`; break;
      case "gap": detail = "no source (gap)"; break;
      case "transition": detail = `inside a transition between ${row.clips.join(" and ")}`; break;
      case "refused": detail = `refused: ${row.clip} · ${row.reason}`; break;
      case "nested": detail = `${row.clip} · ${row.reason}`;
    }
    lines.push([`track ${row.track} (${row.trackName})`, renderPosition(row.sequenceFrame, row.sequenceTimecodes), detail].filter(Boolean).join(" · "));
  }
  if (!output.rows.length) lines.push(output.status);
  return lines.join("\n");
}
