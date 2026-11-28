import {boundIndex,sourceBound} from "../src/domain/source-bound.js";
import { fixtureSource } from "./helpers/source-clock.js";
import type { Content, GenerateContentParameters } from "@google/genai";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GeminiVideoAnalyzer } from "../src/adapters/gemini.js";
import { validateVersionedRunImport } from "../src/domain/integrity.js";
import type { AnalysisDetail, IndexedMoment } from "../src/domain/types.js";
import { secondsToTimestamp, timestampToSeconds } from "../src/lib/time.js";
import { builtInRecipe } from "../src/recipes/index.js";
import { AnalysisOrchestrator } from "../src/services/analyze.js";
import { extractScreenshot } from "../src/services/screenshots.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const warning = "Full-size frame unavailable. Treat any quoted screen text as unverified.";
const rule = [
  "Use neutral label/value details appropriate to the recipe. Record only observed steps. Use the clip for context and audio.",
  "Quote screen words only when you can read them in one attached, labelled still that shows the event. Preserve case, digits and punctuation.",
  "Use that one still for every screen quotation in the record, in any field: titles, prose, details and visible URLs. Cite its label in evidence.timestamp.",
  "If no still is attached, the words are unclear or absent, or the event needs another time, omit unsupported screen words everywhere",
  "and say “Screen text was not read.” Cite the actual event time if known. Never copy screen words from the clip, transcript, speech or examples.",
  "This rule governs every recipe and field. Keep spoken quotations attributable to the speaker.",
].join(" ");
const moments: IndexedMoment[] = ([[20, 29], [30, 40]] as const).map(([start, end]) => ({
  start: secondsToTimestamp(start), end: secondsToTimestamp(end), importance: "high",
  kind: "observation", summary: "A control appears.",
}));
// Distinct 1×1 PNGs stand in for the decoder's output at each selected second.
const png: Record<number, string> = {
  24: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQSDECAAFGAK941HEAAAAAAElFTkSuQmCC",
  32: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQSDECAAFeALfBShjWAAAAAElFTkSuQmCC",
  35: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQTjECAAFnALpSLrPzAAAAAElFTkSuQmCC",
  38: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQSzECAAFwAL2dw53BAAAAAElFTkSuQmCC",
};
const decode: typeof extractScreenshot = async (_video, time, path) => {
  await writeFile(path, png[timestampToSeconds(time)]!, "base64");
  return true;
};
type Request = { parts: NonNullable<Content["parts"]>; repair: boolean; system: string; start: number };
type RunOptions = {
  moments?: IndexedMoment[];
  clock?: "relative" | "absolute";
  repair?: boolean;
  extract?: typeof extractScreenshot;
  screenshots?: boolean;
  recipe?: string;
  duration?: number;
  audioOnly?: boolean;
  reply?: (request: Request) => Partial<AnalysisDetail>;
};

async function run(opts: RunOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "detail-stills-"));
  roots.push(root);
  const video = join(root, "input.mp4");
  if (opts.audioOnly) {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "30", video]);
  } else {
    await writeFile(video, "synthetic recording");
  }
  const requests: Request[] = [];
  const clock = opts.clock ?? "absolute";
  const generateContent = async (parameters: GenerateContentParameters) => {
    const parts = (parameters.contents as Content[])[0]!.parts!;
    const system = String(parameters.config?.systemInstruction);
    const start = parseInt(String(parts[0]!.videoMetadata!.startOffset));
    const req = { parts, start, system, repair: system.includes("previous response was discarded") };
    requests.push(req);
    if (opts.repair && !req.repair) return { text: "{}" };
    const timestamp = secondsToTimestamp(clock === "relative" ? 8 : start + 8);
    const detail: AnalysisDetail = {
      accepted: true, kind: "observation", title: "Control appeared", summary: "A control appeared.",
      evidence: { timestamp }, ...opts.reply?.(req),
    };
    return { text: JSON.stringify(detail) };
  };
  const gemini = new GeminiVideoAnalyzer("test", "gemini-test", { generateContent });
  const orchestrator = new AnalysisOrchestrator({withSourceRecording: fixtureSource(() => opts.duration ?? 50),
    createAnalyzer: () => ({
      model: gemini.model, interrogate: gemini.interrogate.bind(gemini),
      index: async () => ({ matchNotes: "Synthetic.", moments: opts.moments ?? moments }),
      upload: async () => ({ name: "files/test", uri: "https://example.invalid/test", mimeType: "video/mp4" }),
      delete: async () => {}, probeClipClock: async () => 0,
    }),
    createContextSource() { throw new Error("video-only fixture"); },
    calibrateClipClock: async () => ({
      model: gemini.model, result: clock, checkedAt: "2026-11-26T00:00:00Z",
      evidence: { flashFileSeconds: 27, clipStartSeconds: 20, reportedSeconds: clock === "relative" ? 7 : 27 },
    }),
    probeDurationSeconds: async () => opts.duration ?? 50,
    extractScreenshot: async (video, time, path, window, position) => {
      const ok = await (opts.extract ?? decode)(video,time,path,window);
      if (ok && position) position.captured(sourceBound(position.clock,boundIndex(position.target)));
      return ok;
    }, buildContactSheet: async () => undefined,
  });
  const result = await orchestrator.analyze({
    contextMode: "none", video, outputRoot: root, apiKey: "test", recipe: builtInRecipe(opts.recipe ?? "decisions"),
    customRecipe: false, recipeSha256: "a".repeat(64), recipeRevision: "test", screenshots: opts.screenshots ?? false,
    keepUpload: false, derivedTranscript: false, maxIncidents: 5, detailConcurrency: 2,
  });
  return { ...result, requests, read: (name: string) => readFile(join(result.directory, name), "utf8") };
}

it("sends the still-only rule and the ordered labelled PNGs on every detail attempt and repair", async () => {
  for (const clock of ["absolute", "relative"] as const) {
    const result = await run({ clock, repair: true });
    for (const [start, seconds] of [[12, [24]], [22, [32, 35, 38]]] as const) {
      const attempts = result.requests.filter(req => req.start === start);
      expect(attempts.map(req => req.repair)).toEqual([false, true]);
      for (const { parts, repair, system } of attempts) {
        expect(parts[0]).toMatchObject({ videoMetadata: { fps: 1, startOffset: `${start}s` }, fileData: { mimeType: "video/mp4" } });
        expect(parts.slice(1, -1)).toEqual(seconds.flatMap(sec => [
          { text: `Still at ${secondsToTimestamp(clock === "relative" ? sec - start : sec)}` },
          { inlineData: { mimeType: "image/png", data: png[sec] } },
        ]));
        const prompt = parts.at(-1)!.text!.replace(/\s+/g, " ");
        expect(prompt).toContain(rule);
        expect(prompt).not.toContain("Copy relevant visible text and quotes verbatim.");
        expect(prompt).toContain("fully readable in the cited still");
        if (repair) expect(system).toContain("Read screen words only from one attached, labelled still.");
      }
    }
  }
});

it("saves the exact cited PNG for direct and settled recipes even with words only in a detail", async () => {
  for (const recipe of ["decisions", "teaching-points"]) {
    const result = await run({ recipe, screenshots: true, clock: "relative",
      reply: ({ start }) => ({ details: [{ label: "On screen", value: "Save" }], evidence: { timestamp: start === 12 ? "00:00:12" : "00:00:16" } }),
      extract: async (video, time, path, window) => {
        expect(basename(path)).not.toMatch(/^moment-/);
        expect(window).toBeUndefined();
        return decode(video, time, path);
      },
    });
    for (const [i, sec] of [24, 38].entries()) {
      const item = result.analysis.items[i]!;
      expect(item.result.evidence?.timestamp).toBe(secondsToTimestamp(sec));
      expect(await readFile(join(result.directory, item.screenshot!), "base64")).toBe(png[sec]);
    }
    expect(result.requests).toHaveLength(2);
  }
});

it("uses the existing screenshot strategy at an uncaptured citation without snapping or field-based repair", async () => {
  for (const recipe of ["decisions", "teaching-points"]) {
    const result = await run({ recipe, moments: [moments[1]!], screenshots: true,
      reply: () => ({ evidence: { timestamp: "00:00:34", verbatimUiText: "Example" } }),
      extract: async (video, time, path, window) => {
        if (!basename(path).startsWith("moment-")) return decode(video, time, path);
        expect(time).toBe("00:00:34");
        expect(window).toEqual(recipe === "teaching-points" ? { start: "00:00:30", end: "00:00:40" } : undefined);
        await writeFile(path, "uncaptured citation");
        return true;
      },
    });
    expect(await result.read(result.analysis.items[0]!.screenshot!)).toBe("uncaptured citation");
    expect(result.analysis.items[0]?.result.evidence?.timestamp).toBe("00:00:34");
    expect(result.requests).toHaveLength(1);
  }
});

it("keeps an explicit decline and the full warning on no-picture, decode failure and past-end seeks", async () => {
  for (const fault of ["audio only", "bad video", "past end"]) {
    const result = await run({ moments: [moments[0]!], repair: true, audioOnly: fault === "audio only",
      duration: fault === "past end" ? 24 : 50,
      extract: fault === "past end" ? async (_video, time) => { expect(timestampToSeconds(time)).toBeLessThan(24); return false; } : extractScreenshot,
      reply: () => ({ summary: "A dialog opened. Screen words were present. Screen text was not read.", confidenceNotes: "x".repeat(10_000) }),
    });
    expect(result.requests.map(req => req.repair)).toEqual([false, true]);
    for (const { parts } of result.requests) {
      expect(parts).toHaveLength(2);
      const prompt = parts[1]!.text!.replace(/\s+/g, " ");
      expect(prompt).toContain(rule);
      expect(prompt).toContain("When screen words were present but unreadable, say so in the record.");
      expect(prompt).not.toContain("Copy relevant visible text and quotes verbatim.");
    }
    expect(result.outcome.status).toBe("complete");
    const item = result.analysis.items[0]!;
    expect(item.result.summary).toContain("Screen words were present. Screen text was not read.");
    expect(item.result.confidenceNotes).toHaveLength(10_000);
    expect(item.result.confidenceNotes?.endsWith("\n" + warning)).toBe(true);
    expect(item.stillTimes).toEqual([]);
  }
});

it("preserves indexed moments and their times.json entries with and without stills", async () => {
  const withStills = await run({ reply: ({ start }) => ({ evidence: { timestamp: secondsToTimestamp(start === 12 ? 24 : 35) } }) });
  const without = await run({ extract: async () => false });
  expect(withStills.analysis.items.map(item => item.candidate)).toMatchObject(moments);
  expect(without.analysis.items.map(item => item.candidate)).toMatchObject(moments);
  const left = JSON.parse(await withStills.read("times.json"));
  const right = JSON.parse(await without.read("times.json"));
  const candidates = (entries: Array<{ pointer: string }>) => entries.filter(e => e.pointer.includes("/candidate/"));
  expect(candidates(left.entries)).toHaveLength(4);
  expect(candidates(right.entries)).toEqual(candidates(left.entries));
  expect(left.entries).not.toEqual(right.entries);
});

it("renders one stillTimes line per record and imports a historical bundle without stillTimes", async () => {
  const result = await run({
    extract: async (video, time, path) => time !== "00:00:24" && decode(video, time, path),
    reply: ({ start }) => ({ accepted: start === 12 }),
  });
  const items = JSON.parse(await result.read("analysis.json")).items;
  expect(items.map((item: { stillTimes: string[] }) => item.stillTimes)).toEqual([[], ["00:00:32", "00:00:35", "00:00:38"]]);
  for (const artifact of ["report.html", "analysis.md"]) {
    const lines = (await result.read(artifact)).split("\n").filter(line => line.includes("Stills"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("none");
    expect(lines[1]).toContain("Rejected candidate 2");
    expect(lines[1]).toContain("00:00:32, 00:00:35, 00:00:38");
  }
  const historical = JSON.parse(await readFile(new URL("./fixtures/time-lane-base-bundle.json", import.meta.url), "utf8"));
  expect(historical.analysis.items[0]).not.toHaveProperty("stillTimes");
  await expect(validateVersionedRunImport(historical)).resolves.toHaveProperty("analysis.schemaVersion", 3);
});

it("budgets 15 MB of encoded stills per request, reserving the midpoint first", async () => {
  const result = await run({ extract: async (_video, time, path) => {
    // The midpoint of the long candidate fits exactly, leaving no space for either edge.
    // One more raw byte on the short candidate costs another four encoded bytes.
    const size = time === "00:00:24" ? 11_250_001 : time === "00:00:35" ? 11_250_000 : 3;
    await writeFile(path, Buffer.alloc(size, 0x61));
    return true;
  } });
  const short = result.requests.find(req => req.start === 12)!;
  const long = result.requests.find(req => req.start === 22)!;
  expect(short.parts).toHaveLength(2);
  expect(long.parts).toHaveLength(4);
  expect(long.parts[1]!.text).toBe("Still at 00:00:35");
  expect(long.parts[2]!.inlineData?.data?.length).toBe(15_000_000);
  expect(result.analysis.items.map(item => item.stillTimes)).toEqual([[], ["00:00:35"]]);
  expect(result.analysis.items[0]?.result.confidenceNotes).toBe(warning);
  expect(result.analysis.items[1]?.result.confidenceNotes).toBeUndefined();
});

it("still-evidence keeps screen words only when they cite a full-size attached still", async () => {
  const unread = "Screen text was not read from a still.";
  const quote = { verbatimUiText: "Save draft", reporterQuote: "I pressed save." };
  // Stills are at 24 s and at 32, 35 and 38 s. Cite 22 s and 34 s: neither is a still.
  const off = await run({ screenshots: true, extract: async (video, time, path) => {
    if (!basename(path).startsWith("moment-")) return decode(video, time, path);
    await writeFile(path, `frame at ${time}`);
    return true;
  }, reply: ({ start }) => ({ confidenceNotes: "Clear.", evidence: { timestamp: start === 12 ? "00:00:22" : "00:00:34", ...quote } }) });
  for (const [i, time] of ["00:00:22", "00:00:34"].entries()) {
    const item = off.analysis.items[i]!;
    expect(item.result.evidence).toEqual({ timestamp: time, exactTime:expect.objectContaining({origin:"model"}), reporterQuote: quote.reporterQuote });
    expect(item.screenTextNotFromStill).toBe(true);
    expect(item.result.confidenceNotes).toBe(`Clear.\n${unread}`);
    expect(item.candidate).toMatchObject(moments[i]!);
    expect(await off.read(item.screenshot!)).toBe(`frame at ${time}`);
  }
  const markdown = await off.read("analysis.md");
  expect(markdown).not.toContain("Verbatim UI evidence");
  expect(markdown).not.toContain(quote.verbatimUiText);
  expect(markdown.split("Screen text was not read from a still")).toHaveLength(3);
  const report = await off.read("report.html");
  expect(report).not.toContain(quote.verbatimUiText);
  expect(report.split(unread)).toHaveLength(3);
  const stored = JSON.parse(await off.read("analysis.json"));
  await expect(validateVersionedRunImport({ analysis: stored, manifest: JSON.parse(await off.read("manifest.json")) })).resolves.toBeDefined();
  expect(stored.items.map((item: { screenTextNotFromStill?: true }) => item.screenTextNotFromStill)).toEqual([true, true]);

  // A quote that cites a still is left alone, with or without a full notes field.
  const on = await run({ reply: ({ start }) => ({ confidenceNotes: "Clear.", evidence: { timestamp: secondsToTimestamp(start === 12 ? 24 : 35), ...quote } }) });
  for (const item of on.analysis.items) {
    expect(item.result.evidence).toMatchObject(quote);
    expect(item.result.confidenceNotes).toBe("Clear.");
    expect(item).not.toHaveProperty("screenTextNotFromStill");
  }
  // A missing image also leaves screen words unverified.
  const none = await run({ extract: async () => false, reply: () => ({ evidence: { timestamp: "00:00:22", ...quote } }) });
  for (const item of none.analysis.items) {
    expect(item.stillTimes).toEqual([]);
    expect(item.result.evidence).not.toHaveProperty("verbatimUiText");
    expect(item.screenTextNotFromStill).toBe(true);
    expect(item.result.confidenceNotes).toBe(warning + "\n" + unread);
  }
  // Rejected records follow the same evidence rule.
  const plain = await run({ reply: ({ start }) => start === 12 ? {} : { accepted: false, evidence: { timestamp: "00:00:34", ...quote } } });
  expect(plain.analysis.items[0]).not.toHaveProperty("screenTextNotFromStill");
  expect(plain.analysis.items[1]!.result.evidence).not.toHaveProperty("verbatimUiText");
  expect(plain.analysis.items[1]!.screenTextNotFromStill).toBe(true);
});

it("keeps the note within its limit when a removed quote meets a full notes field", async () => {
  const result = await run({ moments: [moments[0]!], reply: () => ({
    confidenceNotes: "x".repeat(10_000), evidence: { timestamp: "00:00:22", verbatimUiText: "Save" } }) });
  const notes = result.analysis.items[0]!.result.confidenceNotes!;
  expect(notes).toHaveLength(10_000);
  expect(notes.endsWith("\nScreen text was not read from a still.")).toBe(true);
});
