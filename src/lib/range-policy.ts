import { applicationSetting } from "./application-settings.js";
import { ContractError } from "../domain/contract-error.js";
import type { RangeClock, RangeRequest } from "../domain/range-clock.js";

export function maxRangeSeconds() {
  const value = applicationSetting("FRAME_OF_MIND_MAX_VIDEO_SECONDS");
  if (value === undefined) return 7260;
  const seconds = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(seconds)) {
    throw new Error("FRAME_OF_MIND_MAX_VIDEO_SECONDS must be a positive integer number of seconds");
  }
  return seconds;
}
export const isRanged = (r: RangeRequest) => r.from !== undefined || r.to !== undefined;

export function enforceRangeLimit(clock: RangeClock) {
  const limitSeconds = maxRangeSeconds();
  if ((clock.to - clock.from) * BigInt(clock.grid.rate.den) > BigInt(limitSeconds) * BigInt(clock.grid.rate.num)) {
    throw new ContractError("RECORDING_TOO_LONG", "The selected range exceeds the recording duration limit.",
      {durationSeconds: clock.elapsed(clock.to - clock.from), limitSeconds});
  }
}
