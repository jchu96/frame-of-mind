import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { childEnvironment } from "../src/lib/child-env.js";
import { runMediaTool } from "../src/services/media-tools.js";
import { readPacketTiming } from "../src/services/packet-timing.js";
import { mediaFixtures } from "./helpers/media-fixtures.js";

const file = mediaFixtures(async dir => {
  const make = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", ...args], {env: childEnvironment("media")});
  const source = "testsrc2=size=160x90:rate=30:duration=4";
  make([source, "-c:v", "libx264", "-preset", "ultrafast", join(dir, "steady.mp4")]);
  make([source, "-vf", "select='not(eq(mod(n,5),2))'", "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast", join(dir, "holes.mov")]);
  make(["sine=frequency=440:duration=1", join(dir, "audio.wav")]);
  const standIn = join(dir, "ffprobe");
  await writeFile(standIn, `#!/bin/sh
[ -z "$FRAME_TIMING_AMBIENT" ] || exit 3
case "$1" in
  slow) exec sleep 5 ;;
  fail) exit 3 ;;
  *) echo '{"streams":[{"time_base":"1/600"}],"packets":[{"pts":0},{},{"pts":40},{},{"pts":80}]}' ;;
esac
`);
  await chmod(standIn, 0o755);
});

test("reads generated steady and gapped video, audio alone, and a missing file", async () => {
  const read = (name: string) => readPacketTiming(() => runMediaTool("ffprobe", ["-protocol_whitelist", "file", "-select_streams", "v:0",
    "-show_entries", "stream=time_base:packet=pts", "-of", "json", file(name)]));
  expect((await read("steady.mp4")).frameTiming).toMatchObject({varying: false, frames: 120, rates: [{framesPerSecond: 30}]});
  const report = (await read("holes.mov")).frameTiming;
  expect(report).toMatchObject({varying: true, frames: 96});
  expect(report.oddShare).toBeGreaterThan(0.2);
  expect((await read("audio.wav")).frameTiming).toEqual({varying: null, frames: 0, unread: "no picture"});
  await expect(read("absent.mov")).rejects.toThrow();
});

test("reports untimed packets and limits, isolates the child, and propagates cancellation and process failure", async () => {
  vi.stubEnv("FRAME_TIMING_AMBIENT", "fixture");
  try {
    const read = (arg: string, signal?: AbortSignal) => readPacketTiming(() => runMediaTool(file("ffprobe"), [arg],
      {signal, timeoutMs: 300}), signal);
    expect((await read("partial")).frameTiming).toEqual({frames: 5, varying: null, unread: "frames with no time", untimedFrames: 2});
    expect((await read("slow")).frameTiming).toEqual({frames: null, varying: null, unread: "scan limit"});
    await expect(read("partial", AbortSignal.abort())).rejects.toThrow();
    await expect(read("fail")).rejects.toThrow();
  } finally { vi.unstubAllEnvs(); }
});
