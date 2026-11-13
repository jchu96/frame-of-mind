import { describe, expect, it } from "vitest";
import { probeFrameRate } from "../src/services/media-probe.js";
import { verifyDay } from "./clock-oracle.js";
const output = (rate: string, average = rate) => async () => JSON.stringify({ streams: [{ r_frame_rate: rate, avg_frame_rate: average }] });
describe("frame rate", () => {
  it("24000/1001 from ffprobe renders every frame of 24 h exactly", async () => {
    const result = await probeFrameRate("synthetic.mp4", "from-media", output("24000/1001"));
    expect(result.rate).toEqual({ num: 24000, den: 1001 }); expect(result.rateOrigin).toBe("media");
    verifyDay(result.rate);
  });
  it("a stream whose r_frame_rate and avg_frame_rate differ is refused", async () => {
    await expect(probeFrameRate("synthetic.mp4", "from-media", output("30/1", "24/1"))).rejects.toThrow("Variable frame rate");
  });
  it("from-media without ffprobe is refused before any provider call", async () => {
    await expect(probeFrameRate("synthetic.mp4", "from-media", async () => { throw Object.assign(new Error(), { code: "ENOENT" }); })).rejects.toThrow("requires ffprobe");
  });
  it("accepts 25/1 and refuses ambiguous, missing and invalid stream metadata", async () => {
    expect((await probeFrameRate("synthetic.mp4", "from-media", output("25/1"))).rate).toEqual({ num: 25, den: 1 });
    await expect(probeFrameRate("synthetic.mp4", "from-media", output("30000/1001"))).rejects.toThrow("Drop-frame must be stated");
    expect((await probeFrameRate("synthetic.mp4", "from-media:df", output("30000/1001"))).dropFrame).toBe(true);
    for (const value of ["0/0", "N/A", "23.98"]) await expect(probeFrameRate("synthetic.mp4", "from-media", output(value))).rejects.toThrow();
    await expect(probeFrameRate("synthetic.mp4", "from-media", async () => '{"streams":[]}')).rejects.toThrow();
  });
});
