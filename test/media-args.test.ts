import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnvironment } from "../src/lib/child-env.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { classify, proposeRecords, snapSettings } from "../src/domain/snap.js";
import { decodeSpeechEnvelope } from "../src/services/audio.js";

let root: string;
const source = "-editor's recording.mp4";
const width = 80, height = 64, count = 30;
function command(...args: string[]) {
  return spawnSync("bun", ["--no-env-file", join(root, "frameofmind.mjs"), ...args],
    {cwd: root, env: childEnvironment("media"), encoding: "utf8"});
}
function success(...args: string[]) {
  const result = command(...args, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
function ffmpeg(args: string[], input?: Buffer) {
  return execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-xerror", ...args], {input, env: childEnvironment("media")});
}
function probeJson(args: string[]) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", ...args], {env: childEnvironment("media"), encoding: "utf8"}));
}
function fixture(name: string, rate: string, label?: string, audio: string[] = []) {
  // Five vertical bars independently encode the low five bits of the frame index.
  const pixels = Buffer.alloc(width * height * count);
  for (let n = 0; n < count; n++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels[(n * height + y) * width + x] = n & (1 << Math.floor(x / 16)) ? 235 : 16;
  }
  ffmpeg(["-f", "rawvideo", "-pixel_format", "gray", "-video_size", "80x64",
    "-framerate", rate, "-i", "pipe:0", ...audio, "-c:v", "libx264", "-g", "90", "-pix_fmt", "yuv420p",
    "-metadata", "location=+12.3456+045.6789/", ...(label ? ["-timecode", label] : []), join(root, name)], pixels);
}
function ids(name: string) {
  const bytes = ffmpeg(["-i", join(root, name), "-map", "0:v:0", "-vf", "scale=80:64",
    "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const result: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += width * height) {
    let id = 0;
    for (let bit = 0; bit < 5; bit++) if (bytes[offset + 32 * width + bit * 16 + 8]! > 128) id |= 1 << bit;
    result.push(id);
  }
  return result;
}
function info(name: string) {
  return probeJson(["-show_format", "-show_streams", "-of", "json", join(root, name)]);
}
async function fingerprint(path: string) {
  const data = await readFile(path);
  return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}
async function damagePacket(sourcePath: string, output: string, stream: string, index: number) {
  const { packets } = probeJson(["-select_streams", stream, "-show_packets", "-show_entries",
    "packet=pos,size", "-of", "json", sourcePath]);
  const { pos, size } = packets.at(index);
  const bytes = await readFile(sourcePath);
  bytes.fill(255, Number(pos), Number(pos) + Number(size));
  await writeFile(output, bytes);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fom-helpers-"));
  execFileSync("bun", ["--no-env-file", "build", "src/cli.ts", "--target=node", "--format=esm",
    "--env=disable", "--outfile", join(root, "frameofmind.mjs")], {env: childEnvironment("media")});
  ffmpeg(["-f", "lavfi", "-i",
    "aevalsrc=if(between(t\\,1\\,1.5)+between(t\\,39\\,40.12)+between(t\\,40.9\\,41.6)\\,0.5\\,0):d=70:s=48000", "-c:a", "flac", join(root, "groups.flac")]);
  fixture(source, "24000/1001", "01:02:03:04");
  const audio = ["-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,0.4)\\,0\\,0.5*sin(2*PI*440*t)):s=48000:d=1.2", "-c:a", "aac"];
  fixture("sound.mp4", "25", "01:02:03:04", audio);
  fixture("df.mp4", "30000/1001", undefined, audio);
  ffmpeg(["-i", join(root, "sound.mp4"), "-map", "0:v:0", "-c:v", "copy", "-f", "matroska", join(root, "disguised.mp4")]);
  await damagePacket(join(root, "sound.mp4"), join(root, "damaged.mp4"), "v:0", 0);
  await damagePacket(join(root, "df.mp4"), join(root, "damaged-audio.mp4"), "a:0", -1);
  const decode = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-i", join(root, "damaged-audio.mp4"), "-f", "null", "-"],
    {env: childEnvironment("media"), encoding: "utf8"});
  expect(decode.status).toBeGreaterThan(0);
  expect(decode.stderr).toMatch(/aac/i);
});
afterAll(async () => {
  if (root) await rm(root, {recursive: true, force: true});
});

it("F01 refuses the recording as a forced proxy destination", async () => {
  const input = join(root, source);
  const before = await fingerprint(input);
  const entries = await readdir(root);
  const result = command("proxy", "--force", "-o", input, "--", source);
  expect(await fingerprint(input), "recording bytes and SHA-256 after forced destination").toEqual(before);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toMatch(/input recording/i);
  expect(await readdir(root)).toEqual(entries);
});

it("F04 preserves independently read timecode and strips the location", () => {
  const out = "-prepared's proxy.mp4";
  const result = success("proxy", "./" + source, "-o", out, "--height", "64");
  expect(result.duration).toMatchObject({clock: "source", frames: "30", rate: {num: 24000, den: 1001}});
  expect(JSON.stringify(info(source))).toContain("+12.3456");
  const report = info(out);
  expect(report.streams[0].tags.timecode, "independent proxy start label").toBe("01:02:03:04");
  expect(JSON.stringify(report)).not.toContain("+12.3456");
  expect(report.streams.find((s: {codec_type: string}) => s.codec_type === "audio")).toMatchObject({codec_name: "aac", channels: 1});
});

it("F05 cuts the requested non-keyframe interval in video and reference audio", () => {
  success("slice", "sound.mp4", "--from", "15f", "--to", "30f", "-o", "cut.mp4");
  const frames = ids("cut.mp4");
  expect(frames).toHaveLength(15);
  expect(frames[0], "first source-frame ID").toBe(15);
  expect(frames.at(-1)).toBe(29);
  expect(info("cut.mp4").streams[0].tags.timecode).toBe("01:02:03:19");
  const pcm = ffmpeg(["-i", join(root, "cut.mp4"), "-map", "0:a:0", "-f", "s16le", "-"]);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  expect(samples.length).toBeGreaterThanOrEqual(28800);
  expect(samples.slice(3000, 4000).some(sample => sample > 3000)).toBe(true);
});

it("grabs the identified full-resolution PNG frame", () => {
  success("frame", "./" + source, "--at", "00:00:00:02", "-o", "grab.png");
  expect(ids("grab.png")).toEqual([2]);
  expect(info("grab.png").streams[0]).toMatchObject({width, height, codec_name: "png"});
});

it("probe counts video without decoding damaged audio or assuming a timecode mode", () => {
  const result = success("probe", "damaged-audio.mp4");
  expect(result.duration.frames).toBe(String(count));
  expect(result.duration.timecode).toBeUndefined();
  expect(result.decodeStatus).toBe("unchecked");
});

it("F06 returns exit 1 one frame off on Matroska with an mp4 extension", () => {
  const result = command("verify", "disguised.mp4", "--expect-frames", "29", "--json");
  expect(result.status, "one-frame mismatch exit").toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({decodeStatus: "passed", actual: {frames: "30"}, expected: {frames: "29"}});
});

it("rejects a corrupt video packet and preserves the old forced output", async () => {
  await writeFile(join(root, "old.mp4"), "keep");
  const entries = await readdir(root);
  expect(command("proxy", "damaged.mp4", "--force", "-o", "old.mp4").status).toBe(1);
  expect(await readFile(join(root, "old.mp4"), "utf8")).toBe("keep");
  expect(await readdir(root)).toEqual(entries);
});

it("verify rejects a damaged final audio packet at the correct video frame count", () => {
  const result = command("verify", "damaged-audio.mp4", "--expect-frames", String(count), "--json");
  expect(result.status, "damaged audio must fail verify").toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({decodeStatus: "failed"});
});

it("W12 bounded snap CLI matches full-file edges at non-grid and near-zero seeks", async () => {
  const file = join(root, "groups.flac");
  const edges = classify((await decodeSpeechEnvelope(file))!);
  for (const [at, ms, end] of [["00:00:41.007", 41007, 40120], ["1.410", 1410, 1500]] as const) {
    const result = success("snap", file, "--at", at, "--edge", "end", "--file-clock", "reel");
    const full = proposeRecords([{ start: 0, end: ms }], edges, "reel", snapSettings()).records[0]!.end;
    expect(result.request).toEqual({ at, clock: "reel", edge: "end" });
    expect(result.result).toMatchObject({ status: "snapped", target: { clock: "reel", gridMs: 10, precisionMs: 50 } });
    if (result.result.status === "snapped" && full.status === "snapped") {
      expect(Math.abs(ms + result.result.shiftMs - end)).toBeLessThanOrEqual(20);
      expect(result.result.target).toEqual(full.target);
      expect(result.result.alternativesMs).toEqual(full.alternativesMs);
    } else throw new Error("Expected a measured offset in both entry points.");
  }
});
