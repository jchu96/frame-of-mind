import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { childEnvironment } from "../src/lib/child-env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as mediaTools from "../src/services/media-tools.js";
import { mediaHelper } from "../src/services/media-helpers.js";

let root: string;
const cli = resolve("src/cli.ts");
const source = "-editor's recording.mp4";
const width = 80, height = 64, count = 30;
function command(...args: string[]) {
  return spawnSync("bun", ["--no-env-file", cli, ...args], { cwd: root, env: childEnvironment("media"), encoding: "utf8", timeout: 30_000 });
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
function fixture(name: string, rate: string, label?: string) {
  // Five vertical bars independently encode the low five bits of the frame index.
  const pixels = Buffer.alloc(width * height * count);
  for (let n = 0; n < count; n++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels[(n * height + y) * width + x] = n & (1 << Math.floor(x / 16)) ? 235 : 16;
  }
  ffmpeg(["-f", "rawvideo", "-pixel_format", "gray", "-video_size", "80x64",
    "-framerate", rate, "-i", "pipe:0", "-c:v", "libx264", "-g", "90", "-pix_fmt", "yuv420p",
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
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fom-helpers-"));
  fixture(source, "24000/1001", "01:02:03:04");
  fixture("plain.mp4", "25");
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
describe("media CLI with real ffmpeg and ffprobe", () => {
  it.each(["direct", "normalized", "symlink", "hardlink"])("F01 refuses forced %s recording and preserves its bytes", async kind => {
    const input = join(root, source);
    let dest = input;
    if (kind === "normalized") dest = root + "/./" + source;
    if (kind === "symlink" || kind === "hardlink") {
      dest = join(root, kind + ".mp4");
      await (kind === "symlink" ? symlink : link)(input, dest);
    }
    const before = await fingerprint(input);
    const entries = await readdir(root);
    const result = command("proxy", "--force", "-o", dest, "--", source);
    expect(await fingerprint(input), "recording bytes and SHA-256 after forced destination").toEqual(before);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/input recording|destination.*link/i);
    expect(await readdir(root)).toEqual(entries);
  });
  it("F04 preserves independently read timecode and strips the location", () => {
    const result = success("proxy", "./" + source, "-o", "-prepared's proxy.mp4", "--height", "64");
    expect(result.duration).toMatchObject({ clock: "source", frames: "30", rate: { num: 24000, den: 1001 } });
    expect(JSON.stringify(info(source))).toContain("+12.3456");
    const out = info("-prepared's proxy.mp4");
    expect(out.streams[0].tags.timecode, "independent proxy start label").toBe("01:02:03:04");
    expect(JSON.stringify(out)).not.toContain("+12.3456");
    expect(out.streams.find((s: {codec_type: string}) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac", channels: 1 });
  });
  it("F05 cuts the exact interior source frame IDs and derived label", () => {
    success("slice", "./" + source, "--from", "2f", "--to", "26f", "-o", "cut.mp4");
    const frames = ids("cut.mp4");
    expect(frames).toHaveLength(24);
    expect(frames[0], "first source-frame ID").toBe(2);
    expect(frames.at(-1)).toBe(25);
    expect(info("cut.mp4").streams[0].tags.timecode).toBe("01:02:03:06");
  });
  it("grabs the identified full-resolution PNG frame", () => {
    success("frame", "./" + source, "--at", "2f", "-o", "grab.png");
    expect(ids("grab.png")).toEqual([2]);
    expect(info("grab.png").streams[0]).toMatchObject({width, height});
  });
  it("slices and verifies the final frame of an untagged recording", () => {
    success("slice", "plain.mp4", "--from", "29f", "--to", "30f", "-o", "one.mp4");
    expect(ids("one.mp4")).toEqual([29]);
    expect(info("one.mp4").streams[0].tags.timecode).toBeUndefined();
    expect(success("verify", "one.mp4", "--timecode-rate", "25", "--expect-frames", "1").decodeStatus).toBe("passed");
  });
  it("reports the probe decode status as unchecked", () => {
    expect(success("probe", "plain.mp4").decodeStatus).toBe("unchecked");
  });
  it("verifies a matching duration", () => {
    expect(success("verify", "plain.mp4", "--expect-duration", "1.200").actual.frames).toBe("30");
  });
  it("F06 returns exit 1 one frame off", () => {
    const result = command("verify", "plain.mp4", "--expect-frames", "29", "--json");
    expect(result.status, "one-frame mismatch exit").toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({actual: {frames: "30"}, expected: {frames: "29"}});
  });
  it.each([
    ["slice", "--from", "0.041", "--to", "3f", "-o", "bad.mp4"],
    ["slice", "--from", "0f", "--to", "0.041", "-o", "bad.mp4"],
    ["frame", "--at", "0.041", "-o", "bad.png"],
    ["verify", "--expect-duration", "0.041"],
  ])("refuses off-grid input for %s %s", (cmd, ...args) => {
    const result = command(cmd, "plain.mp4", ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/1f.*2f/);
  });
});

it("keeps a representable next-day label and refuses a wrapped measurement", async () => {
  fixture("midnight.mp4", "25", "23:59:59:24");
  const result = command("slice", "midnight.mp4", "--from", "2f", "--to", "5f", "-o", "wrap.mp4");
  if (result.status === 0) expect(info("wrap.mp4").streams[0].tags.timecode).toBe("24:00:00:01");
  else {
    expect(result.stderr).toMatch(/24:00:00:01/);
    expect(await readdir(root)).not.toContain("wrap.mp4");
  }
  const {verifyStartLabel} = await import("../src/services/media-helpers.js");
  await expect(verifyStartLabel("24:00:00:01", "00:00:00:01")).rejects.toThrow(/24:00:00:01.*00:00:00:01.*ffmpeg version/);
});
it("rejects a corrupt video packet and preserves the old forced output", async () => {
  const path = join(root, "plain.mp4");
  const packets = probeJson(["-select_streams", "v:0", "-show_packets",
    "-show_entries", "packet=pos,size", "-of", "json", path]).packets;
  const bytes = await readFile(path);
  const packet = packets[0];
  bytes.fill(255, Number(packet.pos), Number(packet.pos) + Number(packet.size));
  await writeFile(join(root, "damaged.mp4"), bytes);
  await writeFile(join(root, "old.mp4"), "keep");
  const entries = await readdir(root);
  const result = command("proxy", "damaged.mp4", "--force", "-o", "old.mp4");
  expect(result.status).toBe(1);
  expect(await readFile(join(root, "old.mp4"), "utf8")).toBe("keep");
  expect(await readdir(root)).toEqual(entries);
});
it("verify rejects a damaged final audio packet at the correct video frame count", async () => {
  const path = join(root, "damaged-audio.mp4");
  ffmpeg(["-i", join(root, "plain.mp4"), "-f", "lavfi", "-i", "sine=duration=1.2:sample_rate=48000",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", path]);
  const packets = probeJson(["-select_streams", "a:0", "-show_packets", "-show_entries", "packet=pos,size",
    "-of", "json", path]).packets;
  const last = packets.at(-1);
  const bytes = await readFile(path);
  bytes.fill(255, Number(last.pos), Number(last.pos) + Number(last.size));
  await writeFile(path, bytes);

  expect(success("probe", path).duration.frames).toBe(String(count));
  const decode = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"],
    {env: childEnvironment("media"), encoding: "utf8"});
  expect(decode.status).toBeGreaterThan(0);
  expect(decode.stderr).toMatch(/aac/i);
  const result = command("verify", path, "--expect-frames", String(count), "--json");
  expect(result.status, "damaged audio must fail verify").toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({decodeStatus: "failed"});
});

it("refuses to publish a staged proxy with a different start label", async () => {
  const realRun = mediaTools.runMediaTool;
  const spy = vi.spyOn(mediaTools, "runMediaTool").mockImplementation((binary, args, options) => {
    if (binary === "ffmpeg" && args.includes("-timecode")) {
      args = [...args];
      args[args.indexOf("-timecode") + 1] = "01:02:03:05";
    }
    return realRun(binary, args, options);
  });
  try {
    const entries = await readdir(root);
    await expect(mediaHelper("proxy", join(root, source), {output: join(root, "wrong-label.mp4"), height: "64"}))
      .rejects.toThrow(/expected 01:02:03:04, measured 01:02:03:05/);
    expect(await readdir(root)).toEqual(entries);
  } finally { spy.mockRestore(); }
});

it("explicitly disables MOV external tracks before opening each video input", async () => {
  const spy = vi.spyOn(mediaTools, "runMediaTool");
  const path = join(root, "plain.mp4");
  try {
    await mediaHelper("proxy", path, {output: join(root, "drefs.mp4"), height: "64"});
    await mediaHelper("frame", path, {output: join(root, "drefs.png"), at: "0f"});
    for (const [binary, args] of spy.mock.calls) {
      const inputIndex = args.indexOf("-i");
      const input = inputIndex < 0 ? args.at(-1)! : args[inputIndex + 1]!;
      if (input.endsWith(".png")) continue; // Opened explicitly with png_pipe.
      expect(input).toMatch(/\.mp4$/);
      const beforeInput = args.slice(0, inputIndex < 0 ? -1 : inputIndex);
      const flag = beforeInput.indexOf("-enable_drefs");
      expect(beforeInput.slice(flag, flag + 2), binary + " MOV input options").toEqual(["-enable_drefs", "0"]);
    }
  } finally { spy.mockRestore(); }
});

it("verifies Matroska by its container even with an mp4 extension", () => {
  const path = join(root, "disguised.mp4");
  ffmpeg(["-i", join(root, "plain.mp4"), "-c:v", "copy", "-f", "matroska", path]);
  expect(success("verify", path, "--expect-frames", String(count)).decodeStatus).toBe("passed");
});
describe("recording with reference audio", () => {
  beforeAll(() => {
    ffmpeg(["-i", join(root, "plain.mp4"), "-f", "lavfi", "-i",
      "aevalsrc=if(lt(t\\,0.4)\\,0\\,0.5*sin(2*PI*440*t)):s=48000:d=1.2",
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", join(root, "sound.mp4")]);
  });
  it("slices real reference audio from its source interval", () => {
    success("slice", "sound.mp4", "--from", "15f", "--to", "20f", "-o", "sound-cut.mp4");
    const pcm = ffmpeg(["-i", join(root, "sound-cut.mp4"), "-map", "0:a:0", "-f", "s16le", "-"]);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    expect(samples.length).toBeGreaterThanOrEqual(9600);
    expect(samples.slice(3000, 4000).some(sample => sample > 3000)).toBe(true);
  });
  it("extracts the identified JPEG frame at an elapsed timecode", () => {
    success("frame", "sound.mp4", "--at", "00:00:00:02", "-o", "image.jpg");
    expect(ids("image.jpg")).toEqual([2]);
  });
});

it("checks projected and measured sizes through the proxy entry point before publishing", async () => {
  const fs = await import("node:fs/promises");
  const realRun = mediaTools.runMediaTool;
  const canonicalInput = await fs.realpath(join(root, "plain.mp4"));
  const output = join(root, "size.mp4");
  let seconds = "230000", oversized = false;
  const events: string[] = [];
  const spy = vi.spyOn(mediaTools, "runMediaTool").mockImplementation(async (binary, args, options) => {
    const result = await realRun(binary, args, options);
    if (binary === "ffprobe" && args.includes("-show_entries") && args.at(-1) === canonicalInput
      && args.some(arg => arg.includes("format=duration"))) {
      const report = JSON.parse(result);
      report.format.duration = seconds;
      return JSON.stringify(report);
    }
    if (binary === "ffmpeg" && args.includes("libx264")) {
      events.push("encoded");
      expect(args[args.indexOf("-vf") + 1]).toContain("fps=25/1");
      expect(args).not.toContain("-r");
      expect(args).not.toContain("-hwaccel");
      if (oversized) {
        // A trailing ISO BMFF free-space atom makes a valid, sparse, oversize MP4.
        const handle = await fs.open(args.at(-1)!, "r+");
        try {
          const size = (await handle.stat()).size;
          const header = Buffer.alloc(8);
          header.writeUInt32BE(2_000_000_001 - size);
          header.write("free", 4);
          await handle.write(header, 0, 8, size);
          await handle.truncate(2_000_000_001);
        } finally { await handle.close(); }
      }
    }
    return result;
  });
  const make = () => mediaHelper("proxy", join(root, "plain.mp4"), {output, height: "64", force: true}, undefined, line => events.push(line));
  try {
    await make();
    expect(events).toEqual([expect.stringContaining("estimate"), expect.stringContaining("Warning"), "encoded"]);
    events.length = 0;
    seconds = "258000";
    await expect(make()).rejects.toThrow("estimate exceeds");
    expect(events).not.toContain("encoded");
    seconds = "1.2"; oversized = true;
    const prior = await fingerprint(output);
    await expect(make()).rejects.toThrow("actual exceeds");
    expect(await fingerprint(output)).toEqual(prior);
  } finally { spy.mockRestore(); }
});

it("requires an independent matching rate for a one-frame recording", () => {
  ffmpeg(["-i", join(root, "plain.mp4"), "-frames:v", "1", join(root, "single.mp4")]);
  expect(command("probe", "single.mp4").stderr).toContain("One-frame timing");
  expect(command("probe", "single.mp4", "--timecode-rate", "24").status).toBe(1);
});

describe("recording at a drop-frame-capable rate", () => {
  beforeAll(() => fixture("df-rate.mp4", "30000/1001"));
  it("probes the frame count without assuming a timecode mode", () => {
    const duration = success("probe", "df-rate.mp4").duration;
    expect(duration.frames).toBe("30");
    expect(duration.timecode).toBeUndefined();
  });
  it("requires an explicit mode for an elapsed timecode", () => {
    expect(command("frame", "df-rate.mp4", "--at", "00:00:00:01", "-o", "df.png").status).toBe(1);
    expect(success("frame", "df-rate.mp4", "--timecode-rate", "29.97df", "--at", "00:00:00;01", "-o", "df.png").at.frames).toBe("1");
  });
  it("refuses a mismatched probe rate", () => {
    expect(command("probe", "df-rate.mp4", "--timecode-rate", "25").status).toBe(1);
  });
});
