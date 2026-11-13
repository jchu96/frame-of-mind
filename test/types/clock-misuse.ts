import { clockTime, sourceToTimeline } from "../../src/domain/clock.js";
// @ts-expect-error A bare number has no clock.
sourceToTimeline(1000, 0);
// @ts-expect-error A structural object cannot bypass the constructor's integer check.
sourceToTimeline({ clock: "source", ms: 1000, precisionMs: 1000 }, 0);
// @ts-expect-error Reel coordinates are not original source coordinates.
sourceToTimeline(clockTime("reel", 1000), 0);
sourceToTimeline(clockTime("source", 1000), 0);
