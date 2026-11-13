import { mkdtemp, readFile, rm, mkdir, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTimes, writeArtifacts } from "../src/services/artifacts.js";
import { declareClock, type RunClock } from "../src/domain/clock.js";
import { runManifestSchema, runManifestV3Schema } from "../src/domain/schemas.js";
import { analysisOutcomeSchema } from "../src/domain/analysis-outcome.js";
import { analysisDigest, validateVersionedRunImport } from "../src/domain/integrity.js";
import type { AnalysisRunV3, RunManifestV3 } from "../src/domain/types.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const analysis: AnalysisRunV3 = {
  schemaVersion: 3, runId: "clock-test", context: { mode: "none" }, recipe: { id: "test", label: "Test" }, model: "gemini-test", matchNotes: "Matched.",
  items: [1, 2].map(i => ({ candidate: { start: `00:00:${i}0`, end: `00:00:${i}9`, kind: "test", importance: "high", summary: "Synthetic candidate" }, result: { accepted: true, kind: "test", title: "Synthetic", summary: "Synthetic evidence", evidence: { timestamp: `00:00:${i}5` } } })),
};
const clock = (rate?: string): RunClock => ({ fileClock: "source", timeline: declareClock("12.345", rate), modelClipClock: "unverified" });
async function write(clocks?: RunClock) {
  const dir = await mkdtemp(join(tmpdir(), "times-test-")); roots.push(dir);
  const manifest: RunManifestV3 = {
    schemaVersion: 3, toolVersion: "0.5.0", promptRevision: "test", runId: analysis.runId,
    startedAt: "2026-11-01T00:00:00Z", completedAt: "2026-11-01T00:00:01Z", context: { mode: "none" },
    recipe: { ...analysis.recipe, custom: false, revision: "test", sha256: "a".repeat(64) },
    model: analysis.model, recordingSha256: "b".repeat(64), analysisSha256: await analysisDigest(analysis), recordingMimeType: "video/mp4", mediaSource: "local-file",
    analysis: { maxIncidents: 10, indexFps: 0.5, indexResolution: "low", interrogationResolution: "medium" },
    artifacts: ["analysis.json", "analysis.md", "report.html", "manifest.json", "analysis-outcome.json", "times.json"], ...(clocks ? { clock: clocks } : {}),
  };
  const outcome = analysisOutcomeSchema.parse({ schemaVersion: 1, runId: analysis.runId, status: "complete", candidates: { indexed: 2, selected: 2, omittedByLimit: 0, validated: 2, accepted: 2, rejected: 0, failed: 0 }, failures: [] });
  await writeArtifacts(dir, analysis, manifest, outcome);
  return { dir, manifest, outcome, md: await readFile(join(dir, "analysis.md"), "utf8"), html: await readFile(join(dir, "report.html"), "utf8"), times: JSON.parse(await readFile(join(dir, "times.json"), "utf8")), json: await readFile(join(dir, "analysis.json"), "utf8") };
}
describe("times.json", () => {
  it("has exactly one entry per time pointer in analysis.json", async () => {
    const result = await write(clock()); const pointers: string[] = [];
    const walk = (value: unknown, path: string) => { if (typeof value === "string" && /^\d{2}:\d{2}:\d{2}$/.test(value)) pointers.push(path); else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => walk(child, `${path}/${key}`)); };
    walk(JSON.parse(result.json), "");
    expect(result.times.entries.map((e: { pointer: string }) => e.pointer).sort()).toEqual(pointers.sort());
    expect(new Set(result.times.entries.map((e: { pointer: string }) => e.pointer)).size).toBe(pointers.length);
  });
  it("an undeclared run has no timeline field anywhere", async () => {
    const result = await write(); expect(JSON.stringify(result)).not.toContain("timeline");
  });
  it("model times carry precisionMs 1000", async () => {
    const result = await write(clock()); expect(result.times.entries.every((e: { precisionMs: number }) => e.precisionMs === 1000)).toBe(true);
  });
  it("every entry value is a number of seconds with at most three decimals", async () => {
    const result = await write(clock());
    for (const e of result.times.entries) for (const name of ["source", "timeline"]) { expect(typeof e[name]).toBe("number"); expect(/^\d+(\.\d{1,3})?$/.test(String(e[name]))).toBe(true); }
    expect(result.times.entries[0].timeline).toBe(22.345);
  });
  it("reel coordinates keep their clock label", () => {
    const times = buildTimes(analysis, { fileClock: "reel", modelClipClock: "absolute" });
    expect(times.fileClock).toBe("reel"); expect(times.entries[0]).toMatchObject({ reel: 10 }); expect(times.entries[0]).not.toHaveProperty("source");
  });
});
describe("render", () => {
  it("every time in report.html carries a clock label", async () => {
    const result = await write(clock("25"));
    const eyebrows = [...result.html.matchAll(/<article>\s*<div class="eyebrow">([^<]+)/g)].map(m => m[1]!);
    expect(eyebrows).toHaveLength(2);
    for (const text of eyebrows) { expect(text).toContain("s source"); expect(text).toContain("s timeline"); expect(text).toContain("≈1 s"); expect(text).toContain("@25"); }
    expect(result.html).toContain("clip clock unverified");
  });
  it("every Markdown time carries a clock label and precision marker", async () => {
    const result = await write(clock()); const lines = result.md.split("\n").filter(l => l.startsWith("- Time:"));
    expect(lines).toHaveLength(2); for (const text of lines) { expect(text).toContain("s source"); expect(text).toContain("s timeline"); expect(text).toContain("≈1 s"); }
  });
});
describe("timecode", () => {
  it("seconds in times.json are identical with and without --timecode-rate", async () => {
    const plain = await write(clock()); const rendered = await write(clock("25"));
    expect(rendered.json).toBe(plain.json);
    expect(rendered.times.entries.map(({ timecode, ...e }: Record<string, unknown>) => e)).toEqual(plain.times.entries);
    const normalized = structuredClone(rendered.manifest); delete normalized.clock!.timeline!.timecode;
    expect(normalized).toEqual(plain.manifest);
  });
  it("a run without --timecode-rate has no timecode field anywhere", async () => {
    expect(JSON.stringify(await write(clock()))).not.toContain("timecode");
  });
});
describe("compatibility", () => {
  it("strict v2 and v3 manifests accept optional clocks and old outcomes still validate", async () => {
    for (const clocks of [undefined, clock("25")]) {
      const { manifest, outcome } = await write(clocks);
      expect(runManifestV3Schema.parse(manifest).clock).toEqual(clocks);
      const { context, ...base } = manifest;
      const v2 = { ...base, schemaVersion: 2, meetingId: "synthetic-meeting", contextProvider: "file", contextTransport: "file", transcriptSha256: "c".repeat(64), transcriptAlignment: { offsetSeconds: 0, method: "explicit", confidence: "high" } };
      expect(runManifestSchema.parse(v2).clock).toEqual(clocks);
      await expect(validateVersionedRunImport({ analysis, manifest, outcome })).resolves.toHaveProperty("outcome");
      await expect(validateVersionedRunImport({ analysis, manifest, outcome: { ...outcome, candidates: { ...outcome.candidates, indexed: 38, outOfRange: 36 } } })).resolves.toHaveProperty("outcome.candidates.outOfRange", 36);
    }
  });
});

describe("web re-import", () => {
  it("accepts clock provenance and old or outOfRange outcomes through the website reader", async () => {
    const { reimportPublishedJobRun, publishedRunDirectory } = await import("../apps/web/server-local/studio-jobs/run-reimport.js");
    for (const outOfRange of [undefined, 36]) {
      const result = await write(clock("25"));
      const job = { stage: "succeeded", runId: analysis.runId, input: { context: { mode: "none" }, mediaSha256: "b".repeat(64) } } as Parameters<typeof publishedRunDirectory>[0];
      const directory = publishedRunDirectory(job, result.dir);
      await mkdir(directory, { recursive: true });
      for (const name of ["analysis.json", "manifest.json", "analysis-outcome.json"]) await copyFile(join(result.dir, name), join(directory, name));
      const outcome = outOfRange === undefined ? result.outcome : { ...result.outcome, candidates: { ...result.outcome.candidates, indexed: 38, outOfRange } };
      await writeFile(join(directory, "analysis-outcome.json"), JSON.stringify(outcome));
      let imported: unknown;
      const store = { async importRun(run: unknown) { imported = await validateVersionedRunImport(run); return { runId: analysis.runId, created: true }; } } as Parameters<typeof reimportPublishedJobRun>[0]["store"];
      await expect(reimportPublishedJobRun({ job, outputRoot: result.dir, store })).resolves.toEqual({ runId: analysis.runId, created: true });
      expect(imported).toMatchObject({ manifest: { clock: clock("25") }, outcome });
    }
  });
});
