import { rationalRate, isDropRate, type FrameRate } from "./time-rate.js";
import type { MediaClock } from "./media-clock.js";

export const TICKS_PER_SECOND = 254016000000n;
const FORMS = "Accepted forms: unsigned whole frames, ticks or milliseconds; HH:MM:SS:FF (non-drop) or HH:MM:SS;FF (drop), at a declared rate.";
function refuse(reason: string): never { throw new Error(`${reason} ${FORMS}`); }
function natural(value: string): bigint {
  if (value.trim() !== value || !/^(0|[1-9]\d*)$/.test(value)) refuse("Expected a non-negative unpadded whole number.");
  return BigInt(value);
}
function namedClock(clock: MediaClock): void {
  if (!["source", "reel", "timeline"].includes(clock)) refuse("Expected a source, reel or timeline clock; time of day is not a cut point.");
}
declare const exactBrand: unique symbol;
export type ExactTime<C extends MediaClock = MediaClock> = Readonly<{
  clock: C; frames: bigint; rate: Readonly<FrameRate>; unit: "video-frame" | "millisecond";
  [exactBrand]: true;
}>;
export type ApproximateTime<C extends MediaClock = MediaClock> = Readonly<{
  clock: C; seconds: string; precisionMs: number; origin: string;
}>;
export type SnappedTime<C extends MediaClock = MediaClock> = ExactTime<C> & Readonly<{
  snappedTo: string; approximate: ApproximateTime;
}>;
export type ExactRange<C extends MediaClock = MediaClock> = { start: ExactTime<C>; duration: ExactTime<C> };

function normalizedRate(rate: FrameRate): FrameRate {
  try { return rationalRate(rate.num, rate.den); }
  catch { return refuse("Rate must contain positive safe whole numbers."); }
}
function makeTime<C extends MediaClock>(clock: C, frames: bigint, rate: FrameRate, unit: ExactTime["unit"]): ExactTime<C> {
  namedClock(clock);
  return Object.freeze({ clock, frames, rate: Object.freeze(rate), unit }) as ExactTime<C>;
}
export function exactTime<C extends MediaClock>(clock: C, frames: string, rate: FrameRate): ExactTime<C> {
  return makeTime(clock, natural(frames), normalizedRate(rate), "video-frame");
}
/** A whole-ms source with no declared video rate. Its internal 1000/1 rate is not video. */
export function fromMilliseconds<C extends MediaClock>(clock: C, ms: string, rate?: FrameRate): ExactTime<C> {
  const value = natural(ms);
  if (!rate) return makeTime(clock, value, { num: 1000, den: 1 }, "millisecond");
  const reduced = normalizedRate(rate);
  return makeTime(clock, value * BigInt(reduced.num) / (1000n * BigInt(reduced.den)), reduced, "video-frame");
}
function nominalRate(time: ExactTime, dropFrame: boolean): bigint {
  if (time.unit !== "video-frame") refuse("Timecode requires a declared video rate.");
  if (typeof dropFrame !== "boolean") refuse("Drop-frame must be stated.");
  if (dropFrame && !isDropRate(time.rate)) refuse("Drop-frame requires 30000/1001 or 60000/1001.");
  return (BigInt(time.rate.num) + BigInt(time.rate.den) - 1n) / BigInt(time.rate.den);
}
export function renderExactTimecode(time: ExactTime, dropFrame: boolean): string {
  const nominal = nominalRate(time, dropFrame);
  let frame = time.frames;
  if (dropFrame) {
    const drop = nominal === 60n ? 4n : 2n;
    const tenMinutes = nominal * 600n - drop * 9n;
    const minute = nominal * 60n - drop;
    const remainder = frame % tenMinutes;
    frame += drop * 9n * (frame / tenMinutes) + (remainder >= drop ? drop * ((remainder - drop) / minute) : 0n);
  }
  const seconds = frame / nominal;
  const fields = [seconds / 3600n, seconds / 60n % 60n, seconds % 60n];
  return `${fields.map(v => String(v).padStart(2, "0")).join(":")}${dropFrame ? ";" : ":"}${String(frame % nominal).padStart(2, "0")}`;
}
export function fromTimecode<C extends MediaClock>(clock: C, value: string, rate: FrameRate, dropFrame: boolean): ExactTime<C> {
  const zero = exactTime(clock, "0", rate);
  const nominal = nominalRate(zero, dropFrame);
  const match = /^(\d{2}|[1-9]\d{2,}):([0-5]\d):([0-5]\d)([:;])(\d{2}|[1-9]\d{2,})$/.exec(value);
  if (!match || match[0] !== value) refuse("Malformed timecode.");
  if (match[4] !== (dropFrame ? ";" : ":")) refuse("Timecode separator must match the stated drop-frame choice.");
  const [hours, minutes, seconds, frames] = [match[1]!, match[2]!, match[3]!, match[5]!].map(BigInt) as [bigint, bigint, bigint, bigint];
  if (frames >= nominal) refuse("Frame field must be below the nominal rate.");
  const drop = dropFrame ? (nominal === 60n ? 4n : 2n) : 0n;
  if (dropFrame && minutes % 10n !== 0n && seconds === 0n && frames < drop) refuse("Drop-frame label does not exist.");
  const totalMinutes = hours * 60n + minutes;
  return exactTime(clock, String(((totalMinutes * 60n + seconds) * nominal + frames) - drop * (totalMinutes - totalMinutes / 10n)), rate);
}
function ticksPerFrame(time: ExactTime): bigint | undefined {
  const numerator = TICKS_PER_SECOND * BigInt(time.rate.den);
  return numerator % BigInt(time.rate.num) === 0n ? numerator / BigInt(time.rate.num) : undefined;
}
export function fromTicks<C extends MediaClock>(clock: C, ticks: string, rate?: FrameRate): ExactTime<C> {
  const value = natural(ticks);
  const zero = rate ? exactTime(clock, "0", rate) : fromMilliseconds(clock, "0");
  const step = ticksPerFrame(zero);
  if (step === undefined) refuse("Ticks per frame are not whole at this rate.");
  if (value % step !== 0n) refuse("Ticks must identify an exact frame boundary.");
  return rate ? exactTime(clock, String(value / step), rate) : fromMilliseconds(clock, String(value / step));
}
/** Derived reading form only. Reconstruct exact time from frames/rate, never this display. */
function derivedSeconds(time: ExactTime): { seconds: string; secondsDerived: true; secondsUnavailable?: never } | { seconds?: never; secondsDerived: true; secondsUnavailable: string } {
  const num = BigInt(time.rate.num), den = BigInt(time.rate.den);
  const ms = (time.frames * 1000n * den + num - 1n) / num;
  if (ms * num >= (time.frames + 1n) * 1000n * den) return { secondsDerived: true, secondsUnavailable: "No whole millisecond falls inside this frame; three-decimal derived seconds are unavailable." };
  return { seconds: `${ms / 1000n}.${String(ms % 1000n).padStart(3, "0")}`, secondsDerived: true };
}
/** Requesting the unavailable seconds form refuses; the other exact forms remain available. */
export function exactSeconds(time: ExactTime): string {
  const result = derivedSeconds(time);
  if (result.seconds === undefined) refuse(result.secondsUnavailable);
  return result.seconds;
}
export function deriveExact(time: ExactTime, dropFrame?: boolean) {
  const step = ticksPerFrame(time);
  const common = { clock: time.clock, ...derivedSeconds(time),
    ...(step === undefined ? { ticksUnavailable: "Ticks per frame are not whole at this rate." } : { ticks: String(time.frames * step) }) };
  return time.unit === "millisecond" ? { ...common, milliseconds: String(time.frames), rateBasis: "whole-millisecond source; no declared video rate" as const }
    : { ...common, frames: String(time.frames), rate: time.rate, timecode: renderExactTimecode(time, dropFrame!), dropFrame: dropFrame! };
}
/** Exact offsets share a rate; no implicit resampling or snapping. */
export function offsetTime<C extends MediaClock>(time: ExactTime, offset: ExactTime<C>): ExactTime<C> {
  if (time.rate.num !== offset.rate.num || time.rate.den !== offset.rate.den || time.unit !== offset.unit) refuse("Exact offsets require the same rate and unit.");
  const frames = String(time.frames + offset.frames);
  return offset.unit === "millisecond" ? fromMilliseconds(offset.clock, frames) : exactTime(offset.clock, frames, offset.rate);
}
/** Pure OTIO export. The floating rate is the only lossy field; unsafe values are refused. */
export function toOtioTime(time: ExactTime) {
  if (time.frames > BigInt(Number.MAX_SAFE_INTEGER)) refuse("OTIO value exceeds the safe whole-frame range.");
  return { OTIO_SCHEMA: "RationalTime.1" as const, value: Number(time.frames), rate: time.rate.num / time.rate.den };
}
export function toOtioRange(range: ExactRange) {
  if (range.start.clock !== range.duration.clock) refuse("A range start and duration must name the same clock.");
  return { OTIO_SCHEMA: "TimeRange.1" as const, start_time: toOtioTime(range.start), duration: toOtioTime(range.duration) };
}
