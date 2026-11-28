import { applicationSetting } from "./application-settings.js";
import type { RangeRequest } from "../domain/range-clock.js";

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
