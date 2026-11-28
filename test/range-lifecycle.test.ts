import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exactTime } from "exact-time";
import { afterEach, expect, test, vi } from "vitest";
import { RangeClock } from "../src/domain/range-clock.js";
import * as encoder from "../src/services/media-helpers.js";
import * as scan from "../src/services/range-scan.js";
import { withVideoRange } from "../src/services/video-range.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
test.each(["encode", "upload", "render"])("releases private range scratch after cancellation during %s", async stage => {
  const root = await mkdtemp(join(tmpdir(), "range-lifecycle-"));
  const path = join(root, "source");
  await writeFile(path, "source sentinel");
  const controller = new AbortController();
  const rate = {num: 25, den: 1};
  const request = {from: "1f", to: "31f"};
  const clock = RangeClock.resolve({rate, unit: "frames", length: 100n}, request);
  const messages: string[] = [];
  let cut = "", consumed = false;
  try {
    vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
    vi.spyOn(scan, "scanRange").mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      return { clock, info: { rate, formatName: "mov", duration: exactTime("source", "100", rate), videoIndex: 0, audio: [],
        width: 16, height: 16, codec: "h264", approximateSeconds: 4 }, seek: {
        keyIndex: 0, expectedPts: Array.from({length: 30}, (_, i) => i + 1), firstPts: 1, endPts: 31, seekSeconds: "0", timeBase: {num: 1, den: 25}
      } };
    });
    vi.spyOn(encoder, "encodeVideoRange").mockImplementation(async (_input, file, _info, _from, _to, _size, signal, _seek, _phase, register) => {
      cut = file;
      register!(process.pid);
      await writeFile(file, "private derivative");
      if (stage === "encode") { controller.abort(); signal!.throwIfAborted(); }
      return {duration: {}, width: 16, height: 16, codec:"h264", hasAudio:false, audio:[], fileStartLabel:null, decodeStatus:"passed"} as
        Awaited<ReturnType<typeof encoder.encodeVideoRange>>;
    });
    await expect(withVideoRange(path, request, false, line => messages.push(line), controller.signal, async () => {
      consumed = true;
      controller.abort();
      if (stage === "render") throw new Error("render failed");
      controller.signal.throwIfAborted();
    })).rejects.toThrow();
    expect(consumed).toBe(stage !== "encode");
    expect(messages.filter(s => s.includes("scanning packets"))).toHaveLength(3);
    expect(messages.filter(s => s.startsWith("Range used:"))).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe("source sentinel");
    await expect(stat(cut)).rejects.toMatchObject({code: "ENOENT"});
    await expect(stat(join(cut, ".."))).rejects.toMatchObject({code: "ENOENT"});
  } finally { await rm(root, {recursive: true, force: true}); }
});
