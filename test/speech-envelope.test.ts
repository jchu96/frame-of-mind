import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, onTestFinished, describe, expect, test, vi } from "vitest";
import { classify, selectEdge, snapSettings, SpeechMeter } from "../src/domain/snap.js";
import { snapFile } from "../src/commands/snap.js";
import { decodeSpeechEnvelope } from "../src/services/audio.js";
import { mediaFixtures } from "./helpers/media-fixtures.js";

const processTestTimeout = 30_000;

async function root() {
  const dir = await mkdtemp(join(tmpdir(), "speech-meter-"));
  onTestFinished(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
afterEach(() => vi.unstubAllEnvs());

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
  // The decoded bursts include a 10 ms shoulder on either side.
  const blocks = Array.from({length: 3}, (_, block) => Float32Array.from({length: 1000}, (_, i) => {
    const ms = (block * 1000 + i) * 10;
    return row.bursts.some(([a, b]) => ms >= Math.round(a * 1000) - 10 && ms < Math.round(b * 1000) + 10) ? -9 : -96;
  }));
  const { result, request } = await snapFile("generated", row, async () => ({blocks, startMs: 0, length: 3000}));
  expect(result.status === "snapped" ? result.target.seconds : request.at).toBe(row.expected);
  expect(result).toMatchObject({ status: row.expected === row.at ? "no-boundary" : "snapped", alternativesMs: [row.alternative] });
});

const formats = [
  { format: "PCM", file: "truth.wav", rate: 48000, precision: 50, tolerance: 20 },
  { format: "AAC in M4A", file: "audio.m4a", rate: 48000, precision: 50, tolerance: 50 },
  { format: "AAC with video in MP4", file: "video.mp4", rate: 48000, precision: 50, tolerance: 50 },
  { format: "AAC in M4A", file: "narrowband.m4a", rate: 8000, precision: 200, tolerance: 200 },
];

describe("decoded speech on the file grid", { timeout: processTestTimeout }, () => {
  const file = mediaFixtures(dir => {
    const pcm = join(dir, "truth.wav");
    const bursts: Burst[] = [[14, 20.120], [20.900, 21.600], [39.230, 40.120], [40.900, 41.600]];
    writeBursts(pcm, bursts);
    const noise = join(dir, "noise.wav");
    writeBursts(noise, bursts, "sgn(random(0)-0.5)");
    for (const row of formats.slice(1)) {
      const video = row.file.endsWith(".mp4") ? ["-f", "lavfi", "-i", "color=s=16x16:r=1:d=45", "-c:v", "libx264"] : [];
      execFileSync("ffmpeg", ["-v", "error", "-i", row.rate === 8000 ? noise : pcm, ...video,
        "-c:a", "aac", "-ar", String(row.rate), "-b:a", "128k", join(dir, row.file)]);
    }
    const path = join(dir, "delayed.mkv");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=size=16x16:rate=1:duration=8",
      "-itsoffset", "1.253", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,1)+between(t\\,3\\,4)\\,0.5\\,0):s=8000:d=6",
      "-c:v", "ffv1", "-c:a", "pcm_s16le", path]);
  });

  test("W9 a delayed audio stream measures bursts on the file grid without inventing leading silence", async () => {
    const meter = await decodeSpeechEnvelope(file("delayed.mkv"));
    expect(meter).toMatchObject({startMs: 1260, sourceSampleRateHz: 8000});
    const edges = classify(meter!);
    expect(selectEdge(edges, "start", 1250, "source", snapSettings(250, 500)).status).toBe("no-boundary");
    for (const [edge, truth] of [["end", 2253], ["start", 4253], ["end", 5253]] as const) {
      const result = selectEdge(edges, edge, truth, "source", snapSettings(250, 500));
      expect(result.status).toBe("snapped");
      if (result.status === "snapped") expect(Math.abs(result.shiftMs)).toBeLessThanOrEqual(20);
    }
  });

  test.each(formats)("$rate Hz $format edges fall within $tolerance ms of the generated burst times", async row => {
    const meter = await decodeSpeechEnvelope(file(row.file));
    expect(meter?.sourceSampleRateHz).toBe(row.rate);
    const edges = classify(meter!);
    for (const [edge, request, truth] of [
      ["start", 14000, 14000], ["end", 21000, 20120], ["start", 21000, 20900], ["end", 22000, 21600],
      ["start", 39000, 39230], ["end", 41000, 40120], ["start", 41000, 40900], ["end", 42000, 41600],
    ] as const) {
      const result = selectEdge(edges, edge, request, "source", snapSettings());
      expect(result).toMatchObject({ status: "snapped", target: { gridMs: 10, precisionMs: row.precision } });
      if (result.status === "snapped") expect(Math.abs(request + result.shiftMs - truth)).toBeLessThanOrEqual(row.tolerance);
    }
  });
});

test("two hours of silence use one float per complete window", () => {
  const meter = new SpeechMeter(0);
  const second = Buffer.alloc(8000 * 2);
  for (let i = 0; i < 7200; i++) meter.write(second);
  const envelope = meter.finish()!;
  expect(envelope.length).toBe(720000);
  expect(envelope.blocks.reduce((sum, block) => sum + block.byteLength, 0)).toBe(2880000);
  expect(classify(envelope)).toEqual({ start: [], end: [], precisionMs: 200 });
});

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
}, processTestTimeout);
test("W11 abort before launch and after first PCM never returns a partial envelope", async () => {
  const dir = await root();
  const input = join(dir, "input.wav");
  const marker = join(dir, "streaming");
  await writeFile(input, "generated");
  await writeFile(join(dir, "ffmpeg"), `#!${process.execPath}\n${packet}
const fs = require('node:fs'), marker = ${JSON.stringify(marker)};
process.stdout.write(Buffer.alloc(166), () => { fs.writeFileSync(marker + '.tmp', 'ready'); fs.renameSync(marker + '.tmp', marker); });
setInterval(() => {}, 1000);`, { mode: 0o700 });
  vi.stubEnv("PATH", dir);
  expect(await decodeSpeechEnvelope(input, { signal: AbortSignal.abort() })).toBeUndefined();
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  const controller = new AbortController();
  const ready = watch(dir, (_, name) => { if (name === "streaming") controller.abort(); });
  try {
    expect(await decodeSpeechEnvelope(input, {signal: controller.signal})).toBeUndefined();
    expect(await readFile(marker, "utf8")).toBe("ready");
    expect(controller.signal.aborted).toBe(true);
  } finally { ready.close(); controller.abort(); }
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  expect(await readFile(input, "utf8")).toBe("generated");
}, processTestTimeout);
