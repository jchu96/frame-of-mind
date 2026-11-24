import { execFileSync, spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { classify, selectEdge, snapSettings } from "../src/domain/snap.js";
import { snapFile } from "../src/commands/snap.js";
import { decodeSpeechEnvelope } from "../src/services/audio.js";

const hasDecoder = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "speech-meter-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test.skipIf(!hasDecoder)("W9 a delayed audio stream measures bursts on the file grid without inventing leading silence", async () => {
  const path = join(await root(), "delayed.mkv");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=size=16x16:rate=1:duration=8",
    "-itsoffset", "1.253", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,1)+between(t\\,3\\,4)\\,0.5\\,0):s=8000:d=6",
    "-c:v", "ffv1", "-c:a", "pcm_s16le", path]);
  const meter = await decodeSpeechEnvelope(path);
  expect(meter?.startMs).toBe(1260);
  const edges = classify(meter!);
  expect(selectEdge(edges, "start", 1250, "source", snapSettings(250, 500)).status).toBe("no-boundary");
  for (const [edge, truth] of [["end", 2253], ["start", 4253], ["end", 5253]] as const) {
    const result = selectEdge(edges, edge, truth, "source", snapSettings(250, 500));
    expect(result.status).toBe("snapped");
    if (result.status === "snapped") expect(Math.abs(result.shiftMs)).toBeLessThanOrEqual(20);
  }
});

type Burst = [number, number];

/** Generate the PCM oracle once, with silence outside the specified half-open bursts. */
function writeBursts(path: string, bursts: Burst[], wave = "sin(2*PI*440*t)") {
  const active = bursts.map(([start, end]) => `(gte(t,${start})*lt(t,${end}))`).join("+");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    `aevalsrc='0.5*${wave}*(${active})':s=48000:d=45`, "-c:a", "pcm_s16le", path]);
}

const crossingCases: { name: string; edge: string; at: string; bursts: Burst[]; expected: string; alternative: number }[] = [
  { name: "an end inside speech keeps the model time when a later offset crosses the next group", edge: "end", at: "20.000",
    bursts: [[14, 20.120], [20.320, 20.920]], expected: "20.000", alternative: 20930 },
  { name: "a start in silence keeps the model time when an earlier onset crosses the previous group", edge: "start", at: "15.000",
    bursts: [[14.300, 14.900], [15.100, 15.700]], expected: "15.000", alternative: 14290 },
  { name: "an end in silence chooses the earlier offset when both pauses qualify", edge: "end", at: "15.000",
    bursts: [[14.500, 14.700], [15.200, 15.700]], expected: "14.710", alternative: 15710 },
  { name: "a start in silence chooses the later onset when both pauses qualify", edge: "start", at: "15.000",
    bursts: [[14.300, 14.800], [15.300, 15.500]], expected: "15.290", alternative: 14290 },
];
for (const row of crossingCases) test(row.name, async () => {
  const file = join(await root(), "bursts.wav");
  writeBursts(file, row.bursts);
  const { result, request } = await snapFile(file, row);
  expect(result.status === "snapped" ? result.target.seconds : request.at).toBe(row.expected);
  expect(result).toMatchObject({ status: row.expected === row.at ? "no-boundary" : "snapped", alternativesMs: [row.alternative] });
});

test.each([
  { format: "PCM", file: "truth.wav", rate: 48000, precision: 50, tolerance: 20 },
  { format: "AAC in M4A", file: "audio.m4a", rate: 48000, precision: 50, tolerance: 50 },
  { format: "AAC with video in MP4", file: "video.mp4", rate: 48000, precision: 50, tolerance: 50 },
  { format: "AAC in M4A", file: "narrowband.m4a", rate: 8000, precision: 200, tolerance: 200 },
])("$rate Hz $format edges fall within $tolerance ms of the generated burst times", async row => {
  const dir = await root();
  const pcm = join(dir, "truth.wav");
  writeBursts(pcm, [[14, 20.120], [20.900, 21.600], [39.230, 40.120], [40.900, 41.600]],
    row.rate === 8000 ? "sgn(random(0)-0.5)" : undefined);
  const file = join(dir, row.file);
  if (file !== pcm) {
    const video = row.file.endsWith(".mp4") ? ["-f", "lavfi", "-i", "color=s=16x16:r=1:d=45", "-c:v", "libx264"] : [];
    execFileSync("ffmpeg", ["-v", "error", "-i", pcm, ...video, "-c:a", "aac", "-ar", String(row.rate), "-b:a", "128k", file]);
  }
  const edges = classify((await decodeSpeechEnvelope(file))!);
  for (const [edge, request, truth] of [
    ["start", 14000, 14000], ["end", 21000, 20120], ["start", 21000, 20900], ["end", 22000, 21600],
    ["start", 39000, 39230], ["end", 41000, 40120], ["start", 41000, 40900], ["end", 42000, 41600],
  ] as const) {
    const result = selectEdge(edges, edge, request, "source", snapSettings());
    expect(result).toMatchObject({ status: "snapped", target: { gridMs: 10, precisionMs: row.precision } });
    if (result.status === "snapped") expect(Math.abs(request + result.shiftMs - truth)).toBeLessThanOrEqual(row.tolerance);
  }
});

test.runIf(hasDecoder && process.env.FOM_SPEECH_COST === "1")("W9 two-hour generated audio decode cost", async () => {
  const path = join(await root(), "two-hours.flac");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "7200", "-c:a", "flac", path]);
  const start = performance.now();
  const meter = await decodeSpeechEnvelope(path);
  const decodeMs = performance.now() - start;
  expect(meter?.length).toBe(720000);
  const bytes = meter!.blocks.reduce((sum, block) => sum + block.byteLength, 0);
  expect(bytes).toBe(2880000);
  expect(classify(meter!)).toEqual({ start: [], end: [], precisionMs: 200 });
  console.log(`W9 duration=7200s decode_wall=${(decodeMs / 1000).toFixed(3)}s decode_and_classify_wall=${((performance.now() - start) / 1000).toFixed(3)}s peak_meter=${bytes} bytes (sum of append-only Float32 block capacities)`);
}, 600000);

const packet = "process.stderr.write('#tb 0: 1/8000\\n0, 0, 0, 83, 166, 0x00000000\\n');";
test("W11 failed, discontinuous and malformed streams discard PCM and preserve the input", async () => {
  const dir = await root();
  const input = join(dir, "input.wav");
  const decoder = join(dir, "ffmpeg");
  await writeFile(input, "original generated bytes");
  vi.stubEnv("PATH", dir);
  const signal = new AbortController().signal;
  const run = (body: string, options = {}) => writeFile(decoder, `#!${process.execPath}\n${body}`, { mode: 0o700 })
    .then(() => decodeSpeechEnvelope(input, { signal, ...options }));
  const pcm = packet + "process.stdout.write(Buffer.alloc(166));";
  expect((await run(pcm))?.length).toBe(1); // 83 complete samples, three beyond the last window.
  for (const body of [pcm + "process.exitCode = 1;", packet + "process.stdout.write(Buffer.alloc(165));",
    pcm + "process.stderr.write('0, 88, 88, 80, 160, 0x00000000\\n');",
    "process.stdout.write(Buffer.alloc(166));", "process.stderr.write('invalid packet');"]) {
    expect(await run(body)).toBeUndefined();
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(await readFile(input, "utf8")).toBe("original generated bytes");
  }
  expect(await run(pcm + "setInterval(() => {}, 1000)", { timeoutMs: 500 })).toBeUndefined();
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  await rm(decoder);
  expect(await decodeSpeechEnvelope(input, { signal })).toBeUndefined(); // spawn error
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  expect(await readFile(input, "utf8")).toBe("original generated bytes");
});
test("W11 abort before launch and after first PCM never returns a partial envelope", async () => {
  const dir = await root();
  const input = join(dir, "input.wav");
  const marker = join(dir, "streaming");
  await writeFile(input, "generated");
  await writeFile(join(dir, "ffmpeg"), `#!${process.execPath}\n${packet}
process.stdout.write(Buffer.alloc(166), () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'));
setInterval(() => {}, 1000);`, { mode: 0o700 });
  vi.stubEnv("PATH", dir);
  expect(await decodeSpeechEnvelope(input, { signal: AbortSignal.abort() })).toBeUndefined();
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  const controller = new AbortController();
  const decoding = decodeSpeechEnvelope(input, { signal: controller.signal });
  try { await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("ready")); }
  finally { controller.abort(); }
  expect(await decoding).toBeUndefined();
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  expect(await readFile(input, "utf8")).toBe("generated");
});
