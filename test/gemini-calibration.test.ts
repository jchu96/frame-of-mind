import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calibrateClipClock, classifyClipClock, synthesizeFlash } from "../src/adapters/gemini-calibration.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const cacheRoot = await mkdtemp(join(tmpdir(), "clock-cache-test-")); roots.push(cacheRoot);
  const analyzer = { model: "gemini-test", upload: vi.fn(async () => ({ name: "files/synthetic" })), probeClipClock: vi.fn(async () => 7), delete: vi.fn(async () => {}) };
  return { analyzer, options: { cacheRoot, synthesize: vi.fn(async () => true), now: () => Date.parse("2026-11-01T00:00:00Z") } };
}
describe("classify", () => {
  it("a 7 s answer to the 27 s flash over clip 20-35 is relative", async () => {
    const { analyzer, options } = await fixture();
    expect((await calibrateClipClock(analyzer, options)).result).toBe("relative");
  });
  it.each([[27, "absolute"], [7, "relative"], [15, "unverified"], [null, "unverified"]] as const)("%s gives %s", (answer, expected) => expect(classifyClipClock(answer)).toBe(expected));
  it("no ffmpeg yields unverified and makes no provider call", async () => {
    const { analyzer, options } = await fixture(); options.synthesize.mockResolvedValue(false);
    expect((await calibrateClipClock(analyzer, options)).result).toBe("unverified");
    expect(analyzer.upload).not.toHaveBeenCalled(); expect(analyzer.probeClipClock).not.toHaveBeenCalled();
  });
});
describe("probe", () => {
  it("deletes its synthetic upload on success and on failure", async () => {
    for (const fail of [false, true]) {
      const { analyzer, options } = await fixture();
      if (fail) analyzer.probeClipClock.mockRejectedValue(new Error("synthetic refusal"));
      const result = await calibrateClipClock(analyzer, options);
      expect(result.result).toBe(fail ? "unverified" : "relative");
      expect(analyzer.delete).toHaveBeenCalledExactlyOnceWith({ name: "files/synthetic" });
      const path = analyzer.upload.mock.calls[0]![0];
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("reuses measurements inside 30 days, refreshes after, and stores private files", async () => {
    const { analyzer, options } = await fixture();
    await calibrateClipClock(analyzer, options);
    await calibrateClipClock(analyzer, { ...options, now: () => options.now() + 29 * 86400000 });
    expect(analyzer.probeClipClock).toHaveBeenCalledTimes(1);
    await calibrateClipClock(analyzer, { ...options, now: () => options.now() + 30 * 86400000 });
    expect(analyzer.probeClipClock).toHaveBeenCalledTimes(2);
    if (process.platform !== "win32") {
      expect((await stat(options.cacheRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(join(options.cacheRoot, "gemini-test.json"))).mode & 0o777).toBe(0o600);
    }
  });
  it("real ffmpeg synthesizes the 40 s flash and deletes local scratch", async () => {
    const { options } = await fixture();
    const path = join(options.cacheRoot, "flash.mp4");
    expect(await synthesizeFlash(path)).toBe(true);
    const { execFileSync } = await import("node:child_process");
    const bytes = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    expect(bytes.length).toBe(40); expect(bytes[27]).toBeGreaterThan(240);
    expect([...bytes].filter(v => v > 240)).toHaveLength(1);
  });
});
