import { describe, expect, it } from "vitest";
import { probeFrameRate } from "../src/services/media-probe.js";
import { verifyDay } from "./clock-oracle.js";
const output = (rate: string, average = rate) => async () => JSON.stringify({ streams: [{ r_frame_rate: rate, avg_frame_rate: average, time_base: `1/${average.split("/")[0]}` }], frames: [0, 1, 2].map(i => ({ pts: i * Number(average.split("/")[1]), pkt_duration: Number(average.split("/")[1]) })) });
describe("frame rate", () => {
  it.each([0, 3, 6, 9, 12, 15, 18, 21])("24000/1001 from ffprobe renders every frame of 24 h exactly (3 h partition starting at %i)", async hour => {
    const result = await probeFrameRate("synthetic.mp4", "from-media", output("24000/1001"));
    expect(result.rate).toEqual({ num: 24000, den: 1001 }); expect(result.rateOrigin).toBe("media");
    verifyDay(result.rate, false, hour, hour + 3);
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

describe("frame timing", () => {
  it("matching summary rates do not admit a shifted frame in real media", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const root = await mkdtemp(join(tmpdir(), "synthetic-clock-timing-"));
    try {
      for (const shift of [false, true]) {
        const path = join(root, `${shift}.mp4`);
        execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=s=160x90:r=25:d=4", "-vf", shift ? "settb=1/1000,setpts=PTS+if(eq(N\\,50)\\,1\\,0)" : "settb=1/1000", "-fps_mode", "vfr", "-enc_time_base", "1:1000", "-c:v", "libx264", "-video_track_timescale", "1000", path]);
        const summary = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate", "-of", "json", path], { encoding: "utf8" }));
        expect(summary.streams[0]).toEqual({ r_frame_rate: "25/1", avg_frame_rate: "25/1" });
        if (shift) await expect(probeFrameRate(path)).rejects.toThrow("Variable frame rate");
        else expect((await probeFrameRate(path)).rate).toEqual({ num: 25, den: 1 });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("missing, shifted, duplicate, quantized, truncated or unsafe timing is refused", async () => {
    const good = JSON.parse(await output("25/1")());
    const mutations = [
      (d: typeof good) => { delete d.frames; },
      (d: typeof good) => { d.frames = []; },
      (d: typeof good) => { delete d.frames[1].pts; },
      (d: typeof good) => { d.frames[1].pts = 0; },
      (d: typeof good) => { d.frames.forEach((f: {pts: number}) => { f.pts += 1; }); },
      (d: typeof good) => { d.frames[1].pts = Number.MAX_SAFE_INTEGER + 1; },
      (d: typeof good) => { delete d.frames[2].pkt_duration; },
      (d: typeof good) => { d.frames[2].pkt_duration = 2; },
      (d: typeof good) => { d.streams[0].nb_frames = "4"; },
      (d: typeof good) => { d.streams[0].time_base = "1/1000"; d.frames = [0, 42, 83].map(pts => ({ pts: pts, pkt_duration: 42 })); d.streams[0].r_frame_rate = d.streams[0].avg_frame_rate = "24000/1001"; },
    ];
    for (const mutate of mutations) {
      const data = structuredClone(good); mutate(data);
      await expect(probeFrameRate("synthetic.mp4", "from-media", async () => JSON.stringify(data))).rejects.toThrow();
    }
  });
});
