import { enforceRangeLimit } from "../../src/lib/range-policy.js";
import { RangeClock } from "../../src/domain/range-clock.js";
import { type SourceOptions, isRanged, type withSourceRecording } from "../../src/services/source-recording.js";

export function fixtureSource(duration: () => number | undefined, rate = {num:25, den:1}): typeof withSourceRecording {
  return async function fixtureRecording<T>(path: string, options: SourceOptions, _needs: "audio" | "video", tell: (line: string) => void,
    consume: (file: string, clock: RangeClock) => Promise<T>) {
    const seconds = duration();
    const clock = seconds === undefined ? RangeClock.wholeTicks({num:1, den:1000}, undefined, "unproven")
      : RangeClock.resolve({unit:"frames", rate, length:BigInt(Math.ceil(seconds * rate.num / rate.den))}, options);
    options.onSourceResolved?.(clock);
    if (isRanged(options)) {
      tell(clock.rangeLine());
      enforceRangeLimit(clock);
    }
    return consume(path, clock);
  };
}
