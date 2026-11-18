import { clockTime, sourceToTimeline } from "../../src/domain/clock.js";
// @ts-expect-error A bare number has no clock.
sourceToTimeline(1000, 0);
// @ts-expect-error A structural object cannot bypass the constructor's integer check.
sourceToTimeline({ clock: "source", ms: 1000, precisionMs: 1000 }, 0);
// @ts-expect-error Reel coordinates are not original source coordinates.
sourceToTimeline(clockTime("reel", 1000), 0);
sourceToTimeline(clockTime("source", 1000), 0);

import { exactTime, deriveExact, type ApproximateTime, type SnappedTime } from "../../src/domain/exact-time.js";
const approximate: ApproximateTime = { clock: "source", seconds: "1.000", precisionMs: 1000, origin: "model" };
// @ts-expect-error Approximate times must never be rendered as exact times.
deriveExact(approximate, false);
const exact = exactTime("source", "24", { num: 24, den: 1 });
// @ts-expect-error A snapped time must retain the target and its approximate origin.
const missingTarget: SnappedTime = { ...exact, approximate };
// @ts-expect-error A snapped time must retain the approximate time it came from.
const missingApproximate: SnappedTime = { ...exact, snappedTo: "word-boundary" };
const snapped: SnappedTime = { ...exact, approximate, snappedTo: "word-boundary" };
deriveExact(snapped, false);

import { renderTimecode } from "../../src/domain/clock.js";
// @ts-expect-error Even the millisecond compatibility renderer needs a DF choice.
renderTimecode(0, { num: 30000, den: 1001 });
