import { ContractError } from "./contract-error.js";
import { exactTime, fromOtioRange, fromOtioTime, offsetTime, type ExactRange, type ExactTime } from "exact-time";
import { sameRate } from "./media-clock.js";
import { z } from "zod";

type Time = ExactTime<"timeline">;
type Bounds = { start: Time; end: Time };
type RecordValue = Record<string, unknown>;

export function difference<C extends "source" | "timeline">(end: ExactTime<C>, start: ExactTime<C>): ExactTime<C> {
  if (!sameRate(end.rate, start.rate)) throw new ContractError("INVALID_INPUT", "Cannot subtract frames at different rates.");
  return exactTime(end.clock, String(end.frames - start.frames), end.rate);
}

type Clip = { kind: "clip"; name: string; range: ExactRange<"source">; available?: ExactRange<"source">; target?: string; refusal?: string };
type Item = Clip | { kind: "gap" | "nested" | "unsupported"; name: string };
export type Segment = Bounds & { item: Item };
export type Transition = Bounds & { left: Segment; right: Segment };
export type VideoTrack = { number: number; name: string; segments: Segment[]; transitions: Transition[] };
export type Timeline = { origin: Time; duration: Time; tracks: VideoTrack[] };

const object = z.record(z.string(), z.unknown());
function children(node: RecordValue) {
  return z.array(object).parse(node.children);
}
function name(node: RecordValue) { return typeof node.name === "string" && node.name || "(unnamed)"; }

function timeEffect(node: RecordValue) {
  return z.array(object).parse(node.effects ?? []).find(effect =>
    /(?:TimeWarp|TimeEffect|FreezeFrame)\.\d+$/.test(String(effect.OTIO_SCHEMA)) || Object.hasOwn(effect, "time_scalar"));
}

function readClip(node: RecordValue, range: ExactRange<"source">): Clip {
  const clip: Clip = { kind: "clip", name: name(node), range };
  const refs = object.safeParse(node.media_references);
  const key = node.active_media_reference_key;
  const active = node.OTIO_SCHEMA === "Clip.1" ? node.media_reference :
    typeof key === "string" && refs.success && Object.hasOwn(refs.data, key) ? refs.data[key] : undefined;
  const ref = object.safeParse(active);
  if (ref.success && ref.data.OTIO_SCHEMA === "ExternalReference.1") {
    if (typeof ref.data.target_url === "string") clip.target = ref.data.target_url;
    try { clip.available = fromOtioRange("source", ref.data.available_range); }
    catch { clip.refusal = "media available_range is unavailable"; }
  }
  if (!clip.target) clip.refusal = "no external media reference";
  if (clip.available && !sameRate(clip.available.start.rate, range.start.rate)) clip.refusal = "source rates differ";
  const effect = timeEffect(node);
  if (effect) clip.refusal = `time effect ${String(effect.OTIO_SCHEMA)}`;
  return clip;
}

function readTrack(node: RecordValue, number: number, zero: Time) {
  if (node.OTIO_SCHEMA !== "Track.1" || node.source_range != null || timeEffect(node)) {
    throw new ContractError("INVALID_INPUT", `Unsupported video track timing on ${name(node)}.`);
  }
  const track: VideoTrack = { number, name: name(node), segments: [], transitions: [] };
  let cursor = zero;
  let pending: { left: Segment; start: Time; end: Time } | undefined;
  for (const entry of children(node)) {
    if (entry.OTIO_SCHEMA === "Transition.1") {
      const left = track.segments.at(-1);
      const before = fromOtioTime("timeline", entry.in_offset);
      const after = fromOtioTime("timeline", entry.out_offset);
      if (pending || !left || left.item.kind !== "clip" || before.frames > difference(cursor, left.start).frames) {
        throw new ContractError("INVALID_INPUT", `Unresolved transition on ${track.name}.`);
      }
      pending = { left, start: difference(cursor, before), end: offsetTime(after, cursor) };
      continue;
    }
    const range = fromOtioRange("source", entry.source_range);
    const end = offsetTime(range.duration, cursor);
    let item: Item;
    if (entry.enabled === false || entry.OTIO_SCHEMA === "Gap.1") item = { kind: "gap", name: name(entry) };
    else if (entry.OTIO_SCHEMA === "Clip.2" || entry.OTIO_SCHEMA === "Clip.1") item = readClip(entry, range);
    else item = { kind: entry.OTIO_SCHEMA === "Stack.1" ? "nested" : "unsupported", name: name(entry) };
    const segment = { start: cursor, end, item };
    if (pending) {
      const previous = track.transitions.at(-1);
      if (item.kind !== "clip" || pending.end.frames > end.frames || (previous && previous.end.frames > pending.start.frames)) {
        throw new ContractError("INVALID_INPUT", `Unresolved transition on ${track.name}.`);
      }
      track.transitions.push({ ...pending, right: segment });
      pending = undefined;
    }
    track.segments.push(segment);
    cursor = end;
  }
  if (pending) throw new ContractError("INVALID_INPUT", `Missing second clip for transition on ${track.name}.`);
  return { track, duration: cursor };
}

export function readTimeline(value: unknown): Timeline {
  const root = object.safeParse(value);
  if (!root.success || root.data.OTIO_SCHEMA !== "Timeline.1") throw new ContractError("INVALID_INPUT", "Expected a Timeline.1 timeline export.");
  const stack = object.parse(root.data.tracks);
  if (stack.OTIO_SCHEMA !== "Stack.1" || stack.source_range != null || stack.enabled === false || timeEffect(stack)) {
    throw new ContractError("INVALID_INPUT", "Unsupported timeline track stack or timing.");
  }
  const origin = fromOtioTime("timeline", root.data.global_start_time);
  const zero = exactTime("timeline", "0", origin.rate);
  const tracks: VideoTrack[] = [];
  let duration = zero;
  const video = children(stack).filter(child => child.kind === "Video");
  for (const [i, child] of video.entries()) {
    if (child.enabled === false) continue;
    const parsed = readTrack(child, i + 1, zero);
    if (parsed.track.segments.every(s => s.item.kind === "gap")) continue;
    tracks.push(parsed.track);
    if (parsed.duration.frames > duration.frames) duration = parsed.duration;
  }
  return { origin, duration, tracks: tracks.reverse() };
}

export function contains(range: Bounds | ExactRange, time: ExactTime) {
  const end = "end" in range ? range.end : offsetTime(range.start, range.duration);
  return sameRate(range.start.rate, time.rate) && range.start.frames <= time.frames && time.frames < end.frames;
}
