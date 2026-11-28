import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { expect, test } from "vitest";
import { childEnvironment } from "../src/lib/child-env.js";
import { mediaHelper } from "../src/services/media-helpers.js";
import { displayOrder, packetRow, scanRange } from "../src/services/range-scan.js";
import { localRecording } from "../src/services/media-tools.js";
import { withAudioRange } from "../src/services/audio-range.js";
import { withVideoRange } from "../src/services/video-range.js";
import { mediaFixtures } from "./helpers/media-fixtures.js";

const width = 112, height = 32, frameSize = width * height;
function media(tool: string, args: string[], input?: Buffer) {
  return execFileSync(tool, ["-v", "error", ...args], { input, env: childEnvironment("media"), maxBuffer: 4 * 1024 * 1024 });
}
const file = mediaFixtures(() => {
  const frames = Buffer.alloc(frameSize * 128);
  for (let i = 0; i < frames.length; i++) {
    const id = Math.floor(i / frameSize), bit = Math.floor((i % width) / 16);
    frames[i] = id & (1 << bit) ? 235 : 16;
  }
  for (const [name, rate] of [["ntsc", "30000/1001"], ["pal", "25"]] as const) {
    media("ffmpeg", ["-f", "rawvideo", "-pixel_format", "gray", "-video_size", `${width}x${height}`, "-framerate", rate,
      "-i", "pipe:0", "-f", "lavfi", "-i", "sine=frequency=800:sample_rate=48000:duration=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-x264-params", "keyint=24:min-keyint=24:scenecut=0:bframes=3:b-adapt=0:open-gop=0",
      "-c:a", "pcm_s16le", "-f", "mp4", "-movflags", "+negative_cts_offsets", "-use_editlist", "0", file(name + ".mp4")], frames);
  }
  media("ffmpeg", ["-i", file("pal.mp4"), "-map", "0:v:0", "-c", "copy", "-use_editlist", "1", file("edited.mp4")]);
  media("ffmpeg", ["-i", file("pal.mp4"), "-map", "0:v:0", "-c:v", "mpeg4", file("mpeg4.mp4")]);
  media("ffmpeg", ["-i", file("ntsc.mp4"), "-map", "0:v:0", "-c:v", "libx264", "-x264-params",
    "open-gop=1:keyint=24:min-keyint=24:scenecut=0:bframes=3:b-adapt=0", "-movflags", "+negative_cts_offsets", "-use_editlist", "0", file("open.mp4")]);
  media("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=1200:sample_rate=44100:duration=3", "-c:a", "pcm_s16le", file("native.wav")]);
});
function pixels(path: string) {
  return media("ffmpeg", ["-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
}
function id(bytes: Buffer) {
  let value = 0;
  for (let bit = 0; bit < 7; bit++) if (bytes[width * 10 + 16 * bit + 8]! > 128) value |= 1 << bit;
  return value;
}
test.each([["ntsc", 31, 92, 24], ["pal", 1, 32, 0]] as const)(
  "seek cut matches the from-zero slice at every source frame (%s)", async (name, from, to, keyIndex) => {
    const src = file(name + ".mp4"), reference = file(name + "-reference.mp4");
    const bounds = { from: from + "f", to: to + "f" };
    await mediaHelper("slice", src, { ...bounds, output: reference, height: String(height) });
    const baseline = pixels(reference), original = await readFile(src);
    const progress: string[] = [];
    let cut = "";
    await withVideoRange(src, bounds, false, line => progress.push(line), undefined, async (path, selection) => {
      expect(selection.seek?.keyIndex, progress.join("\n")).toBe(keyIndex);
      cut = path;
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const output = pixels(path);
      expect(output.length).toBe((to - from) * frameSize);
      for (let i = 0; i < to - from; i++) {
        const actual = output.subarray(i * frameSize, (i + 1) * frameSize);
        const expected = baseline.subarray(i * frameSize, (i + 1) * frameSize);
        expect(id(actual), `cut frame ${i} must be source frame ${from + i}`).toBe(Number(selection.clock.sourceIndex(BigInt(i))));
        expect(actual.equals(expected), `decoded pixels differ at cut frame ${i}`).toBe(true);
      }
      if (name === "ntsc") {
        // MOV sample duration
        // trims AAC encoder delay and tail padding on playback.
        const metadata = JSON.parse(media("ffprobe", ["-select_streams", "a:0", "-show_streams", "-of", "json", path]).toString());
        const stream = metadata.streams[0];
        expect(stream.time_base).toBe("1/48000");
        const first = Math.ceil(from * 1001 * 48000 / 30000);
        const end = Math.ceil(to * 1001 * 48000 / 30000);
        expect(first + stream.start_pts).toBe(first);
        expect(first + stream.start_pts + stream.duration_ts - 1).toBe(end - 1);
      }
    });
    expect((await readFile(src)).equals(original)).toBe(true);
    await expect(stat(cut)).rejects.toMatchObject({ code: "ENOENT" });
  });

test("refuses a missing PTS, duplicated display instant and shifted origin", () => {
  expect(() => packetRow("dts=0|duration=1|pos=0|size=5|flags=K_")).toThrow("missing packet timestamps");
  const p = packetRow("pts=0|dts=0|duration=1|pos=0|size=5|flags=K_");
  const grid = { num: 25, den: 1 }, base = { num: 1, den: 25 };
  expect(() => displayOrder([p, { ...p, dts: 1 }], base, grid)).toThrow("duplicate");
  expect(() => displayOrder([{ ...p, pts: 2 }], base, grid)).toThrow("nonzero stream start");
});

test.each([
  ["edited.mp4", "MP4 edit list"],
  ["mpeg4.mp4", "not progressive AVC in MP4"],
  ["open.mp4", "open group at seek point"],
])("reports why %s requires the from-zero path", async (name, reason) => {
  const events: string[] = [];
  const selection = await scanRange(await localRecording(file(name!)), {from: "31f", to: "92f"}, false, undefined, why => events.push(why));
  expect(events).toContain(reason);
  expect(selection.seek).toBeUndefined();
  expect(selection.clock.from).toBe(31n);
});

test("audio-only cut preserves every native PCM sample on a moved 44100 Hz interval", async () => {
  const source = file("native.wav");
  const raw = (path: string) => media("ffmpeg", ["-i", path, "-map", "0:a:0", "-f", "s16le", "-"]);
  const pcm = raw(source);
  await withAudioRange(source, {from: "0.001", to: "1.001"}, () => {}, undefined, async (path, clock) => {
    expect(clock.from).toBe(44n);
    expect(clock.to).toBe(44145n);
    expect(raw(path).equals(pcm.subarray(2 * 44, 2 * 44145))).toBe(true);
  });
});
