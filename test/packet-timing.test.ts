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
  *) printf '%s\\n' 'packet|pts=0' 'packet|pts=N/A' 'packet|pts=40' 'packet|pts=N/A' 'packet|pts=80' 'stream|time_base=1/600' ;;
esac
`);
  await chmod(standIn, 0o755);
});

test("reads generated steady and gapped video, audio alone, and a missing file", async () => {
  const read = (name: string) => readPacketTiming(() => runMediaTool("ffprobe", ["-protocol_whitelist", "file", "-select_streams", "v:0",
    "-show_entries", "stream=time_base:packet=pts", "-of", "compact", file(name)]));
  expect((await read("steady.mp4")).frameTiming).toMatchObject({varying: false, frames: 120, rates: [{framesPerSecond: 30}]});
  const report = (await read("holes.mov")).frameTiming;
  expect(report).toMatchObject({varying: true, frames: 96});
  expect(report.oddShare).toBeGreaterThan(0.2);
  expect((await read("audio.wav")).frameTiming).toEqual({varying: null, frames: 0, unread: "no picture"});
  await expect(read("absent.mov")).rejects.toMatchObject({code: "DECODE_FAILED", message: expect.stringContaining("ffprobe")});
});

test("reports untimed packets and limits, isolates the child, and propagates cancellation and process failure", async () => {
  vi.stubEnv("FRAME_TIMING_AMBIENT", "fixture");
  try {
    const read = (arg: string, signal?: AbortSignal) => readPacketTiming(() => runMediaTool(file("ffprobe"), [arg],
      {signal, timeoutMs: 300}), signal);
    expect((await read("partial")).frameTiming).toEqual({frames: 5, varying: null, unread: "frames with no time", untimedFrames: 2});
    expect((await read("slow")).frameTiming).toEqual({frames: null, varying: null, unread: "scan limit"});
    await expect(read("partial", AbortSignal.abort())).rejects.toMatchObject({name: "AbortError"});
    await expect(read("fail")).rejects.toMatchObject({code: "DECODE_FAILED"});
  } finally { vi.unstubAllEnvs(); }
});

test.each([["steady.mp4", 0], ["holes.mov", 4]] as const)("probe --json returns packet timing for %s with exit %i", async (name, code) => {
  const {Command} = await import("commander");
  const {registerMedia} = await import("../src/commands/media.js");
  const {runCli} = await import("../src/cli-contract.js");
  const {validateCliDocument} = await import("./helpers/cli-schema.js");
  const program = new Command();
  registerMedia(program);
  const tools = await import("../src/services/media-tools.js");
  const media = vi.spyOn(tools, "runMediaTool");
  const prior = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    process.exitCode = 0;
    await runCli(program, ["probe", file(name), "--json"]);
    const doc = validateCliDocument("probe", String(stdout.mock.calls[0]?.[0]));
    expect(Number(process.exitCode)).toBe(code);
    const scans = media.mock.calls.filter(([, args]) => args.includes("-select_streams"));
    expect(scans).toHaveLength(1);
    expect(scans[0]![1]).toContainEqual(expect.stringContaining("packet=pts"));
    if (code === 0) {
      expect(doc.frameTiming).toMatchObject({varying: false, frames: 120, oddGaps: 0, rates: [{framesPerSecond: 30}]});
    } else {
      expect(doc.error).toMatchObject({code: "INVALID_RATE", details: {frameTiming: {varying: true, frames: 96}}});
      expect(doc.error.message).toMatch(/frame rate varies.*analyze and transcribe.*whole/i);
    }
  } finally {
    media.mockRestore();
    stdout.mockRestore();
    process.exitCode = prior;
  }
});
