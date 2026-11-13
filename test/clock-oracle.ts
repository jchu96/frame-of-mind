import { renderTimecode } from "../src/domain/clock.js";
// Integer endpoints and an independent sequential label counter are the oracle.
export function verifyDay(rate: { num: number; den: number }, drop = false, hourStart = 0, hourEnd = 24) {
  const nominal = Math.ceil(rate.num / rate.den);
  const frames = Math.floor(hourEnd * 3600 * rate.num / rate.den);
  const startFrame = Math.floor(hourStart * 3600 * rate.num / rate.den);
  let h = 0, m = 0, s = 0, f = 0;
  let prefix = "";
  for (let frame = 0; frame < frames; frame++) {
    if (frame >= startFrame) {
    const first = Math.ceil(frame * 1000 * rate.den / rate.num);
    const last = Math.ceil((frame + 1) * 1000 * rate.den / rate.num) - 1;
    if (frame === startFrame || f === 0 || (drop && s === 0 && f <= 4)) prefix = `${[h, m, s].map(n => String(n).padStart(2, "0")).join(":")}${drop ? ";" : ":"}`;
    const expected = prefix + String(f).padStart(2, "0");
    for (const ms of [first, last]) {
      const actual = renderTimecode(ms, rate, drop);
      if (actual !== expected) throw new Error(`frame ${frame}, ms ${ms}: ${actual} != ${expected}`);
    }
    }
    if (++f === nominal) {
      f = 0;
      if (++s === 60) {
        s = 0;
        if (++m === 60) { m = 0; h++; }
        if (drop && m % 10 !== 0) f = nominal === 60 ? 4 : 2;
      }
    }
  }
}
