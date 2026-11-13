import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileContextSource, parseCaptionTranscript } from "../src/adapters/file-context.js";
import { renderSpeakers, renderSrt, renderTranscriptJson, writePrivateAtomic } from "../src/services/transcript-render.js";
import type { DerivedTranscriptionSegment } from "../src/domain/types.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const provenance = { model: "gemini-test", clock: "source" as const, recordingSha256: "a".repeat(64), createdAt: "2026-11-13T00:00:00.000Z" };
const segment = (text: string): DerivedTranscriptionSegment => ({ start: "00:00:02", end: "00:00:04", speaker: "Speaker 1", text });
const directories: string[] = [];
async function target() {
  const directory = await fs.mkdtemp(join(tmpdir(), "fom-render-test-"));
  directories.push(directory);
  return join(directory, "synthetic.srt");
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

describe("srt", () => {
  const attacks = [
    "hi\n\n99\n00:00:00,000 --> 00:00:01,000\nInjected",
    "00:00:05,000 --> 00:00:06,000", "00:00:05,000 --> 00:00:06,000 synthetic",
  ];
  it("every --> in the rendered file is on a timing line after a cue number", () => {
    const rendered = renderSrt(attacks.map(segment)).text;
    const lines = rendered.split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("-->")) return;
      expect(line, `unsafe arrow on line ${index + 1}: ${line}`).toMatch(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
      expect(lines[index - 1], `arrow without cue number: ${line}`).toMatch(/^\d+$/);
    });
  });
  it("injected cue text leaves the parsed cue count equal to the segment count", () => {
    const lines = parseCaptionTranscript(renderSrt(attacks.map(segment)).text).split("\n");
    expect(lines).toHaveLength(attacks.length);
    expect(lines.some(line => /^\[[^\]]+\] Injected$/.test(line))).toBe(false);
  });
  it("a blank line inside text does not split the cue", () => {
    const text = renderSrt([segment("synthetic\n\ncontinuation")]).text;
    expect(text).toBe("1\n00:00:02,000 --> 00:00:04,000\nsynthetic continuation\n\n");
    expect(parseCaptionTranscript(text)).toBe("[00:00:02] synthetic continuation");
  });
  it("a blank segment writes no cue, renumbers contiguously and counts blankCues 1", () => {
    const segments = ["a", "   ", "b"].map(segment);
    expect(renderSrt(segments)).toEqual({ text: "1\n00:00:02,000 --> 00:00:04,000\na\n\n2\n00:00:02,000 --> 00:00:04,000\nb\n\n", adjustedCues: 0, blankCues: 1 });
    const json = JSON.parse(renderTranscriptJson(segments, provenance));
    expect(json.blankCues).toBe(1);
    expect(json.segments).toHaveLength(3);
    expect(renderSpeakers(segments, provenance).trimEnd().split("\n")).toHaveLength(4);
  });
  it("adjusts only emitted reversed or zero-length cues and preserves overlaps", () => {
    const segments = [segment("first"), { ...segment("second"), end: "00:00:01" }, { ...segment("third"), end: "00:00:02" }];
    const rendered = renderSrt(segments);
    expect(rendered.adjustedCues).toBe(2);
    expect(rendered.text.match(/00:00:02,000 --> 00:00:03,000/g)).toHaveLength(2);
    expect(JSON.parse(renderTranscriptJson(segments, provenance)).adjustedCues).toBe(2);
    expect(renderSrt([])).toEqual({ text: "", adjustedCues: 0, blankCues: 0 });
  });
});

describe("round trip", () => {
  it("parseCaptionTranscript of renderSrt equals the written-out [start] N(C(text)) lines for 1, 3 and 200 segments", () => {
    // Independent expectations: no parser or production normalizer builds the oracle.
    const inputs = ["SYNTHETIC <marker> TOKEN", "   ", "synthetic\n\ncontinuation", "left --> right", "<marker>"];
    const expected = ["[00:00:02] SYNTHETIC  TOKEN", "", "[00:00:02] synthetic continuation", "[00:00:02] left -- > right", ""];
    for (const count of [1, 3, 200]) {
      const segments = Array.from({ length: count }, (_, i) => segment(inputs[i % inputs.length]!));
      const lines = Array.from({ length: count }, (_, i) => expected[i % expected.length]!).filter(Boolean);
      expect(parseCaptionTranscript(renderSrt(segments).text)).toBe(lines.join("\n"));
    }
  });
});

describe("provenance", () => {
  it("the speakers file starts with the origin, model, clock and timing header", async () => {
    const text = renderSpeakers([segment("SYNTHETIC <marker> TOKEN")], provenance);
    expect(text.split("\n")[0]).toBe("# frame-of-mind transcript; origin: gemini-audio; model: gemini-test; clock: source; timing: reference-grade (whole-second)");
    const path = (await target()).replace(/\.srt$/, "_speakers.txt");
    await writePrivateAtomic(path, text);
    const meeting = await new FileContextSource(path).meeting("synthetic");
    expect(meeting.transcript).toContain("[00:00:02] Speaker 1: SYNTHETIC <marker> TOKEN");
  });
});

describe("json", () => {
  it("segment times are numbers of seconds with clock source", () => {
    const result = JSON.parse(renderTranscriptJson([segment("synthetic")], provenance));
    expect(result).toMatchObject({ ...provenance, schemaVersion: 1, kind: "frame-of-mind.transcript", origin: "gemini-audio", timing: "reference-grade", segments: [{ start: 2, end: 4, speaker: "Speaker 1", text: "synthetic" }] });
  });
});

describe("write", () => {
  it("a failure mid-write leaves the old file intact and no .partial file", async () => {
    const path = await target();
    await fs.writeFile(path, "old");
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await write("incomplete");
        throw new Error("synthetic disk failure");
      });
      return handle;
    });
    await expect(writePrivateAtomic(path, "new", { force: true })).rejects.toThrow("synthetic disk failure");
    expect(await fs.readFile(path, "utf8")).toBe("old");
    expect(await fs.readdir(join(path, ".."))).toEqual(["synthetic.srt"]);
  });
  it("the final file mode is 0600", async () => {
    const path = await target();
    await writePrivateAtomic(path, "synthetic");
    if (process.platform !== "win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    await fs.chmod(path, 0o644);
    await writePrivateAtomic(path, "replacement", { force: true });
    if (process.platform !== "win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path, "utf8")).toBe("replacement");
  });
  it("an existing target is refused without --force", async () => {
    const path = await target();
    await fs.writeFile(path, "old");
    await expect(writePrivateAtomic(path, "new")).rejects.toThrow("--force");
    expect(await fs.readFile(path, "utf8")).toBe("old");
  });
  it("refuses a target created concurrently and removes its temporary file", async () => {
    const path = await target();
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      await fs.writeFile(path, "concurrent");
      return actual.open(...args);
    });
    await expect(writePrivateAtomic(path, "new")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(path, "utf8")).toBe("concurrent");
    expect(await fs.readdir(join(path, ".."))).toEqual(["synthetic.srt"]);
  });
});
