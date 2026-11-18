import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { declareClock, clockDeclarationSchema, declaredOffset, type RunClock } from "../src/domain/clock.js";
import { buildTimes, writeArtifacts, renderClockTime } from "../src/services/artifacts.js";
import { timesSchema } from "../src/domain/times.js";
import { runManifestV3Schema } from "../src/domain/schemas.js";
import { validateVersionedRunImport } from "../src/domain/integrity.js";
const base = JSON.parse(readFileSync(new URL("./fixtures/time-lane-base-bundle.json", import.meta.url), "utf8"));
const oldTimes = JSON.parse(readFileSync(new URL("./fixtures/time-lane-times-v1.json", import.meta.url), "utf8"));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const runClock = (offset: string, rate?: string): RunClock => ({ fileClock: "source", modelClipClock: "unverified", timeline: declareClock(offset, rate) });

test("a timeline offset of 86400 frames at 24000/1001 is stored exactly", () => {
  const frame = declareClock("86400f", "24000/1001")!;
  const code = declareClock("01:00:00:00", "24000/1001")!;
  expect(frame).toEqual(code);
  expect(frame).toMatchObject({ exactOffset: { clock: "timeline", frames: "86400", rate: { num: 24000, den: 1001 }, unit: "video-frame" }, timelineOffsetMs: 3603600 });
  expect(declaredOffset(frame).frames).toBe(86400n);
});

test("an offset between frames is refused and names the two nearest frames", () => {
  expect(() => declareClock("0.5", "24000/1001")).toThrow("between frames 11f and 12f");
  expect(declareClock("1.001", "24000/1001")?.exactOffset?.frames).toBe("24");
  expect(() => declareClock("0.001", "25")).toThrow("between frames 0f and 1f");
});

test("a drop-frame offset at a non-drop rate is refused", () => {
  expect(() => declareClock("00:01:00;02", "29.97ndf")).toThrow("separator");
  expect(declareClock("00:01:00;02", "29.97df")?.exactOffset?.frames).toBe("1800");
  for (const offset of ["-1f", " 1f", "01f", "", "00:01:00", "00:00:00:01 "]) expect(() => declareClock(offset, "25")).toThrow("Accepted");
  expect(() => declareClock("1f")).toThrow("require --timecode-rate");
});

test("an exact time carries frames, rate, ticks, timecode, dropFrame, seconds and clock", () => {
  expect(buildTimes(base.analysis, runClock("1f", "24000/1001")).timeline?.offset).toEqual({
    clock: "timeline", frames: "1", rate: { num: 24000, den: 1001 }, ticks: "10594584000", timecode: "00:00:00:01", dropFrame: false, seconds: "0.042", origin: "declared",
  });
});

test("an offset of one frame at 24000/1001 has no millisecond field", () => {
  const offset = declareClock("1f", "24000/1001")!;
  expect(offset).not.toHaveProperty("timelineOffsetMs");
  expect(clockDeclarationSchema.safeParse({ ...offset, timelineOffsetMs: 42 }).success).toBe(false);
  expect(clockDeclarationSchema.safeParse({ ...offset, exactOffset: { ...offset.exactOffset, rate: { num: 25, den: 1 } } }).success).toBe(false);
});

test("an approximate time carries seconds and precision and no frames, ticks or timecode in JSON, Markdown and HTML", async () => {
  const clock = runClock("1f", "24000/1001");
  const times = buildTimes(base.analysis, clock);
  expect(times.entries[0]).toEqual({ pointer: "/items/0/candidate/start", time: { clock: "source", seconds: "10.000", precisionMs: 1000, origin: "model" }, timeline: { clock: "timeline", seconds: "10.042", precisionMs: 1000, origin: "model" } });
  for (const entry of times.entries) for (const time of [entry.time, entry.timeline!]) {
    expect(Object.keys(time).sort()).toEqual(["clock", "origin", "precisionMs", "seconds"]);
    expect(time.precisionMs).toBe(1000);
  }
  const dir = await mkdtemp(join(tmpdir(), "time-output-")); roots.push(dir);
  await writeArtifacts(dir, base.analysis, { ...base.manifest, clock }, { schemaVersion: 1, runId: base.analysis.runId, status: "complete", candidates: { indexed: 2, selected: 2, omittedByLimit: 0, validated: 2, accepted: 2, rejected: 0, failed: 0 }, failures: [] });
  const markdown = await readFile(join(dir, "analysis.md"), "utf8");
  const html = await readFile(join(dir, "report.html"), "utf8");
  const modelLines = [...markdown.split("\n").filter(l => l.startsWith("- Time:")), ...[...html.matchAll(/<article>\s*<div class="eyebrow">([^<]+)/g)].map(m => m[1]!)];
  expect(modelLines).toHaveLength(4);
  for (const line of modelLines) { expect(line).toContain("≈1 s; model"); expect(line).not.toMatch(/\d+:\d{2}:\d{2}[:;]\d{2}/); expect(line).not.toMatch(/frames|ticks/); }
  expect(renderClockTime("00:00:10", clock)).toBe("10.000 s source (≈1 s; model) · 10.042 s timeline (≈1 s; model)");
});

test("a timeline time made from a model time keeps precisionMs 1000", () => {
  expect(buildTimes(base.analysis, runClock("86400f", "24000/1001")).entries[0]?.timeline).toEqual({ clock: "timeline", seconds: "3613.600", precisionMs: 1000, origin: "model" });
});

test("without a declared rate exact offsets expose milliseconds seconds and ticks only", () => {
  const times = buildTimes(base.analysis, runClock("12.345"));
  expect(times.exactTimeCapability).toContain("no frames or timecode");
  expect(times.timeline?.offset).toEqual({ clock: "timeline", milliseconds: "12345", seconds: "12.345", ticks: "3135827520000", rateBasis: "whole-millisecond source; no declared video rate", origin: "declared" });
  expect(times.entries[0]?.timeline?.seconds).toBe("22.345");
});

test("times.json schema 2 rejects schema 1 shape and the reverse", () => {
  expect(timesSchema.safeParse(oldTimes).success).toBe(false);
  const current = buildTimes(base.analysis, runClock("1f", "24000/1001"));
  expect(timesSchema.parse(current)).toEqual(current);
  expect(timesSchema.safeParse({ ...oldTimes, schemaVersion: 2 }).success).toBe(false);
  // A pinned schema-1 consumer's version/entry contract, exercised against the base-produced artifact.
  const readsSchema1 = (value: typeof oldTimes) => value.schemaVersion === 1 && value.entries.every((e: Record<string, unknown>) => typeof e.source === "number" && typeof e.precisionMs === "number");
  expect(readsSchema1(oldTimes)).toBe(true);
  expect(readsSchema1(current)).toBe(false);
});

test("a manifest written at the base validates including through the website re-import", async () => {
  expect(runManifestV3Schema.parse(base.manifest)).toEqual(base.manifest);
  expect(buildTimes(base.analysis, base.manifest.clock).timeline?.offset).toHaveProperty("milliseconds", "12345");
  expect(buildTimes(base.analysis, base.manifest.clock).timeline?.offset).not.toHaveProperty("frames");
  expect(base.manifest.clock.timeline).toEqual({ timelineOffsetMs: 12345, origin: "declared", timecode: { rate: { num: 25, den: 1 }, dropFrame: false, rateOrigin: "declared" } });
  await expect(validateVersionedRunImport(base)).resolves.toHaveProperty("manifest.clock.timeline.timelineOffsetMs", 12345);
  const { reimportPublishedJobRun, publishedRunDirectory } = await import("../apps/web/server-local/studio-jobs/run-reimport.js");
  const root = await mkdtemp(join(tmpdir(), "base-manifest-")); roots.push(root);
  const job = { stage: "succeeded", runId: base.analysis.runId, input: { context: { mode: "none" }, mediaSha256: base.manifest.recordingSha256 } } as Parameters<typeof publishedRunDirectory>[0];
  const directory = publishedRunDirectory(job, root);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "analysis.json"), JSON.stringify(base.analysis));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(base.manifest));
  let imported: unknown;
  const store = { async importRun(run: unknown) { imported = await validateVersionedRunImport(run); return { runId: base.analysis.runId, created: true }; } } as Parameters<typeof reimportPublishedJobRun>[0]["store"];
  await expect(reimportPublishedJobRun({ job, outputRoot: root, store })).resolves.toEqual({ runId: base.analysis.runId, created: true });
  expect(imported).toMatchObject({ manifest: base.manifest });
});


test("fixture artifact writer emits times.json with and without a declared video rate", async () => {
  for (const rate of [undefined, "24000/1001"]) {
    const dir = await mkdtemp(join(tmpdir(), "time-fixture-receipt-")); roots.push(dir);
    const clock = runClock(rate ? "1f" : "12.345", rate);
    await writeArtifacts(dir, base.analysis, { ...base.manifest, clock }, { schemaVersion: 1, runId: base.analysis.runId, status: "complete", candidates: { indexed: 2, selected: 2, omittedByLimit: 0, validated: 2, accepted: 2, rejected: 0, failed: 0 }, failures: [] });
    const times = timesSchema.parse(JSON.parse(await readFile(join(dir, "times.json"), "utf8")));
    expect(times.timeline?.offset).toHaveProperty("ticks");
    for (const entry of times.entries) for (const time of [entry.time, entry.timeline!]) expect(Object.keys(time).sort()).toEqual(["clock", "origin", "precisionMs", "seconds"]);
    process.stdout.write(`TIME_LANE_ARTIFACT_FIXTURE ${rate ?? "no-rate"} ${JSON.stringify(times)}\n`);
  }
});
