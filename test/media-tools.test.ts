import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as mediaTools from "../src/services/media-tools.js";
import { mediaHelper } from "../src/services/media-helpers.js";
import { runMediaTool, stageOutput } from "../src/services/media-tools.js";

let root: string, input: string, output: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fom-media-tools-"));
  input = join(root, "original.mp4"); output = join(root, "prepared.mp4");
  await writeFile(input, "synthetic recording");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, {recursive: true, force: true}); });
const digest = async () => createHash("sha256").update(await readFile(input)).digest("hex");
it.each(["normalized", "symlink", "hardlink"])("F01 refuses the %s alias of the recording", async kind => {
  let dest = root + "/./original.mp4";
  if (kind !== "normalized") {
    dest = output;
    await (kind === "symlink" ? symlink : link)(input, dest);
  }
  const before = await digest(), entries = await readdir(root);
  await expect(stageOutput(input, dest, [".mp4"], true, undefined, staged => writeFile(staged, "candidate")))
    .rejects.toThrow(/input recording|destination.*link/i);
  expect(await digest()).toBe(before);
  expect(await readdir(root)).toEqual(entries);
});
it("F02 preserves original bytes after cancellation following an encoded frame", async () => {
  const before = await digest();
  const controller = new AbortController();
  const outcome = await stageOutput(input, output, [".mp4"], false, controller.signal, async staged => {
    await runMediaTool("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=s=32x32:r=25", "-frames:v", "1", "-c:v", "libx264", staged]);
    expect((await stat(staged)).size).toBeGreaterThan(0);
    controller.abort();
  }).catch(error => error);
  expect(await digest().catch(() => "original missing"), "original exists and hash matches").toBe(before);
  expect(outcome).toMatchObject({name: "AbortError"});
  expect(await readdir(root)).toEqual(["original.mp4"]);
});
it("F03 rejects error stderr even with a plausible staged file and a zero exit", async () => {
  await expect(stageOutput(input, join(root, "image.ppm"), [".ppm"], false, undefined, async staged => {
    await runMediaTool(process.execPath, ["-e",
      "require('node:fs').writeFileSync(process.argv[1], 'P3\\n1 1\\n255\\n0 0 0\\n'); process.stderr.write('decode error')", staged]);
  }), "error-level stderr must fail publication").rejects.toThrow("reported a media error");
  expect(await readdir(root)).toEqual(["original.mp4"]);
});
it.each(["missing", "timeout", "abort"])("cleans staging and retains prior output on %s", async kind => {
  await writeFile(output, "prior output");
  const controller = new AbortController();
  await expect(stageOutput(input, output, [".mp4"], true, controller.signal, async staged => {
    await writeFile(staged, "partial");
    const timer = kind === "abort" ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      await runMediaTool(kind === "missing" ? join(root, "absent") : process.execPath, ["-e", "setInterval(()=>{},1000)"],
        { signal: controller.signal, timeoutMs: kind === "timeout" ? 100 : 2000 });
    } finally { clearTimeout(timer); }
  })).rejects.toThrow();
  expect(await readFile(output, "utf8")).toBe("prior output");
  expect((await readdir(root)).sort()).toEqual(["original.mp4", "prepared.mp4"]);
});
it("real child sees only the allowed environment", async () => {
  vi.stubEnv("FOM_UNLISTED_MARKER", "synthetic");
  expect(await runMediaTool(process.execPath, ["-p", "typeof process.env.FOM_UNLISTED_MARKER"])).toBe("undefined\n");
});
it("publishes exactly one competing no-force output", async () => {
  const results = await Promise.allSettled(["one", "two"].map(value =>
    stageOutput(input, output, [".mp4"], false, undefined, staged => writeFile(staged, value))));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(["one", "two"]).toContain(await readFile(output, "utf8"));
  expect((await readdir(root)).sort()).toEqual(["original.mp4", "prepared.mp4"]);
});

it("warns or refuses on prediction and permits size equality and override", async () => {
  const {checkProxyBytes, estimateProxyBytes} = await import("../src/services/media-helpers.js");
  const lines: string[] = [];
  const tell = (line: string) => lines.push(line);
  expect(estimateProxyBytes(1280, 720, 25n, 1)).toBe(243168);
  checkProxyBytes(1_800_000_000, false, "estimate", tell);
  expect(lines).toHaveLength(1);
  checkProxyBytes(1_900_000_000, false, "estimate", tell);
  expect(lines.at(-1)).toContain("Warning");
  expect(() => checkProxyBytes(2_100_000_000, false, "estimate", tell)).toThrow("estimate exceeds");
  checkProxyBytes(2_100_000_000, true, "estimate", tell);
  checkProxyBytes(2_000_000_000, false, "actual", tell);
  checkProxyBytes(2_100_000_000, true, "actual", tell);
});
it("refuses a destination replaced during encoding and preserves its new contents", async () => {
  await writeFile(output, "old");
  await expect(stageOutput(input, output, [".mp4"], true, undefined, async staged => {
    await writeFile(staged, "new");
    await rm(output);
    await writeFile(output, "external replacement");
  })).rejects.toThrow("Destination changed");
  expect(await readFile(output, "utf8")).toBe("external replacement");
});
it("refuses an input edited in place during staging", async () => {
  // Make the edit observable even on filesystems with coarse timestamps.
  await utimes(input, new Date(0), new Date(0));
  const before = await stat(input, {bigint: true});
  await expect(stageOutput(input, output, [".mp4"], false, undefined, async staged => {
    await writeFile(staged, "candidate");
    await writeFile(input, "Synthetic recording", {flag: "r+"});
    expect(await stat(input, {bigint: true})).toMatchObject({dev: before.dev, ino: before.ino, size: before.size});
  }), "same-inode edit must stop publication").rejects.toThrow("Input recording changed");
  expect(await readFile(input, "utf8")).toBe("Synthetic recording");
  expect(await readdir(root)).toEqual(["original.mp4"]);
});

it("explains an existing destination lock and leaves it in place", async () => {
  const lock = join(root, ".prepared.mp4.fom-lock");
  await mkdir(lock);
  await expect(stageOutput(input, output, [".mp4"], false, undefined, staged => writeFile(staged, "candidate")))
    .rejects.toThrow(/\.prepared\.mp4\.fom-lock.*interrupted run.*safe to remove.*no other frameofmind command is writing to this destination/i);
  expect((await readdir(root)).sort()).toEqual([".prepared.mp4.fom-lock", "original.mp4"]);
});
it("never replaces an outside publisher that wins creation of an absent target", async () => {
  await expect(stageOutput(input, output, [".mp4"], true, undefined, async staged => {
    await writeFile(staged, "candidate");
    await writeFile(output, "winner", {flag: "wx"});
  })).rejects.toThrow("Destination changed");
  expect(await readFile(output, "utf8")).toBe("winner");
});

it("refuses a dangling link, a directory, and a destination with the wrong extension", async () => {
  const dangling = join(root, "dangling.mp4"), directory = join(root, "folder.mp4");
  await symlink(join(root, "missing.mp4"), dangling);
  await mkdir(directory);
  for (const destination of [dangling, directory, join(root, "wrong.mov")]) {
    await expect(stageOutput(input, destination, [".mp4"], true, undefined, () => Promise.reject(new Error("unexpected encoder"))))
      .rejects.toThrow(/Destination/);
  }
  expect((await readdir(root)).sort()).toEqual(["dangling.mp4", "folder.mp4", "original.mp4"]);
});

// Replay just the two ffprobe reports that inspectVideo consumes. The tool
// processes receive the production argv and operate on the real staged path.
async function reports({rate = "25/1", frames = 30, stagedFrames = frames, seconds = "1.2",
  label = "", stagedLabel = label, bytes = 1} = {}) {
  const [num, den] = rate.split("/").map(Number);
  const timing = (count: number) => ({streams: [{r_frame_rate: rate, avg_frame_rate: rate, time_base: "1/" + num,
    nb_read_frames: String(count)}], frames: Array.from({length: count}, (_, i) => ({pts: i * den!, duration: den}))});
  const metadata = (timecode: string) => ({format: {format_name: "mov", duration: seconds}, streams: [
    {index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 80, height: 64,
      tags: timecode ? {timecode} : {}}, {index: 1, codec_type: "audio", codec_name: "aac", channels: 1}]});
  const image = {streams: [{codec_name: "mjpeg", width: 80, height: 64, nb_read_frames: "1"}]};
  await writeFile(join(root, "ffprobe"), `#!/bin/sh
for last do :; done
case "$*:$last" in
  *jpeg_pipe*) echo '${JSON.stringify(image)}' ;;
  *-count_frames*:*/output.mp4) echo '${JSON.stringify(timing(stagedFrames))}' ;;
  *-count_frames*) echo '${JSON.stringify(timing(frames))}' ;;
  *format=duration*:*/output.mp4) echo '${JSON.stringify(metadata(stagedLabel))}' ;;
  *format=duration*) echo '${JSON.stringify(metadata(label))}' ;;
  *) exit 1 ;;
esac`, {mode: 0o700});
  await writeFile(join(root, "ffmpeg"), `#!/bin/sh
for last do :; done
case "$last" in
  -version) echo 'ffmpeg version fixture' ;;
  -) exit 0 ;;
  *.mp4|*.jpg) "${process.execPath}" -e 'require("node:fs").truncateSync(process.argv[1], ${bytes})' "$last" ;;
  *) exit 1 ;;
esac`, {mode: 0o700});
  vi.stubEnv("PATH", root);
}

it("refuses to publish a staged proxy with a different start label", async () => {
  await reports({label: "01:02:03:04", stagedLabel: "01:02:03:05"});
  const entries = await readdir(root);
  await expect(mediaHelper("proxy", input, {output, height: "64"})).rejects.toThrow(/expected 01:02:03:04, measured 01:02:03:05/);
  expect(await readdir(root)).toEqual(entries);
});

it("refuses a staged slice whose next-day label wrapped at midnight", async () => {
  await reports({label: "23:59:59:24", stagedLabel: "00:00:00:01", stagedFrames: 3});
  await expect(mediaHelper("slice", input, {output, height: "64", from: "2f", to: "5f"}))
    .rejects.toThrow(/expected 24:00:00:01, measured 00:00:00:01.*ffmpeg version/);
  await expect(readFile(output)).rejects.toMatchObject({code: "ENOENT"});
  await reports({label: "23:59:59:24", stagedLabel: "24:00:00:01", stagedFrames: 3});
  await expect(mediaHelper("slice", input, {output, height: "64", from: "2f", to: "5f"})).resolves.toMatchObject({kind: "slice"});
});

it("passes local MOV options before each video input and chooses the requested encoder", async () => {
  await reports();
  const spy = vi.spyOn(mediaTools, "runMediaTool");
  await mediaHelper("proxy", input, {output, height: "64"});
  await mediaHelper("frame", input, {output: join(root, "frame.jpg"), at: "00:00:00:02"});
  for (const [binary, args] of spy.mock.calls) {
    if (args.includes("jpeg_pipe")) continue;
    const inputIndex = args.indexOf("-i");
    expect(inputIndex < 0 ? args.at(-1) : args[inputIndex + 1]).toMatch(/\.mp4$/);
    const beforeInput = args.slice(0, inputIndex < 0 ? -1 : inputIndex);
    const flag = beforeInput.indexOf("-enable_drefs");
    expect(beforeInput.slice(flag, flag + 2), binary + " MOV input options").toEqual(["-enable_drefs", "0"]);
  }
  const encodes = spy.mock.calls.filter(([, args]) => args.includes("-y")).map(([, args]) => args);
  expect(encodes[0]).toContainEqual(expect.stringContaining("fps=25/1"));
  expect(encodes[0]).not.toContain("-r");
  expect(encodes[0]).not.toContain("-hwaccel");
  expect(encodes[1]).toEqual(expect.arrayContaining(["mjpeg", "trim=start_frame=2,setpts=PTS-STARTPTS"]));
});

it("checks projected and measured proxy sizes before publication", async () => {
  const events: string[] = [];
  const make = () => mediaHelper("proxy", input, {output, height: "64", force: true}, undefined, line => events.push(line));
  const run = mediaTools.runMediaTool;
  vi.spyOn(mediaTools, "runMediaTool").mockImplementation((binary, args, options) => {
    if (args.includes("libx264")) events.push("encoded");
    return run(binary, args, options);
  });
  await reports({seconds: "230000"});
  await make();
  expect(events).toEqual([expect.stringContaining("estimate"), expect.stringContaining("Warning"), "encoded"]);
  await writeFile(output, "prior");
  events.length = 0;
  await reports({seconds: "258000"});
  await expect(make()).rejects.toThrow("estimate exceeds");
  expect(events).not.toContain("encoded");
  await reports({bytes: 2_000_000_001});
  await expect(make()).rejects.toThrow("actual exceeds");
  expect(await readFile(output, "utf8")).toBe("prior");
});

it("accepts only matching independent timing for a single untagged frame", async () => {
  await reports({frames: 1});
  await expect(mediaHelper("probe", input, {})).rejects.toThrow("One-frame timing");
  await expect(mediaHelper("probe", input, {timecodeRate: "24"})).rejects.toThrow("One-frame timing");
  await expect(mediaHelper("verify", input, {timecodeRate: "25", expectDuration: "0.040"}))
    .resolves.toMatchObject({actual: {frames: "1"}, mismatches: [], decodeStatus: "passed"});
});

it("requires a matching rate and explicit drop-frame mode for an elapsed label", async () => {
  await reports({rate: "30000/1001"});
  await expect(mediaHelper("probe", input, {timecodeRate: "25"})).rejects.toThrow("Declared rate differs");
  const flags = {output: join(root, "df.jpg"), at: "00:00:00:01"};
  await expect(mediaHelper("frame", input, flags)).rejects.toThrow("explicit df or ndf");
  await expect(mediaHelper("frame", input, {...flags, timecodeRate: "29.97df", at: "00:00:00;01"}))
    .resolves.toMatchObject({at: {frames: "1"}});
});

it.each([
  ["slice", {from: "0.041", to: "3f"}], ["slice", {from: "0f", to: "0.041"}],
  ["frame", {at: "0.041"}], ["verify", {expectDuration: "0.041"}],
] as const)("refuses off-grid input for %s %j", async (kind, flags) => {
  await reports();
  await expect(mediaHelper(kind, input, {output: kind === "frame" ? join(root, "grab.jpg") : output, ...flags}))
    .rejects.toThrow(/1f.*2f/);
});

it("slices the single final frame without adding a start label", async () => {
  await reports({stagedFrames: 1});
  const calls = vi.spyOn(mediaTools, "runMediaTool");
  await mediaHelper("slice", input, {output, height: "64", from: "29f", to: "30f"});
  const encode = calls.mock.calls.find(([, args]) => args.includes("libx264"))![1];
  expect(encode).toContainEqual(expect.stringContaining("trim=start_frame=29:end_frame=30,"));
  expect(encode).not.toContain("-timecode");
});
