import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { expect, test, vi } from "vitest";
import { registerSnap, snapFile } from "../src/commands/snap.js";
import { classify, proposeRecords, snapSettings } from "../src/domain/snap.js";
import { decodeSpeechEnvelope } from "../src/services/audio.js";

test("W12 invalid seconds, elapsed fields, timecodes, clocks and edges fail before decode", async () => {
  const decode = vi.fn();
  for (const at of ["-1", "1:60:00", "00:01:61", "00:01:02:12", "00:01:00;02", "1e9", "2.1234", "02:01", " 0", "1\n", "9007199254740.992", "999999999999999:00:00"]) {
    await expect(snapFile("x", { at, edge: "end" }, decode)).rejects.toThrow();
  }
  for (const flags of [{ at: "0", edge: "middle" }, { at: "0", edge: "end", fileClock: "timeline" }]) {
    await expect(snapFile("x", flags, decode)).rejects.toThrow();
  }
  expect(decode).not.toHaveBeenCalled();
});

test.skipIf(spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0)("W12 bounded real decode matches full-file analysis for a non-grid reel request and a near-zero seek", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snap-cli-"));
  const file = join(dir, "groups.flac");
  try {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(between(t\\,1\\,1.5)+between(t\\,39\\,40.12)+between(t\\,40.9\\,41.6)\\,0.5\\,0):d=70:s=48000", "-c:a", "flac", file]);
    const edges = classify((await decodeSpeechEnvelope(file))!);
    const decode = vi.fn(decodeSpeechEnvelope);
    for (const [at, ms, end] of [["00:00:41.007", 41007, 40120], ["1.410", 1410, 1500]] as const) {
      const result = await snapFile(file, { at, edge: "end", fileClock: "reel" }, decode);
      const full = proposeRecords([{ start: 0, end: ms }], edges, "reel", snapSettings()).records[0]!.end;
      expect(result.request).toEqual({ at, clock: "reel", edge: "end" });
      expect(result.result).toMatchObject({ status: "snapped", target: { clock: "reel", gridMs: 10, precisionMs: 50 } });
      if (result.result.status === "snapped" && full.status === "snapped") {
        expect(Math.abs(ms + result.result.shiftMs - end)).toBeLessThanOrEqual(20);
        expect(result.result.target).toEqual(full.target);
        expect(result.result.alternativesMs).toEqual(full.alternativesMs);
      } else throw new Error("Expected a measured offset in both entry points.");
    }
    expect(decode.mock.calls.map(call => call[1]?.slice)).toEqual([{ startMs: 24170, endMs: 57840 }, { startMs: 0, endMs: 18240 }]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previous = process.exitCode;
    try {
      const cli = new Command();
      registerSnap(cli);
      await cli.parseAsync(["snap", file, "--at", "41.007", "--edge", "end", "--file-clock", "reel"], { from: "user" });
      expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/reel end 41.007 · snapped.*measured on a 10 ms grid, accurate to about ±50 ms/));
      await cli.parseAsync(["snap", file, "--at", "15", "--edge", "end", "--json"], { from: "user" });
      expect(JSON.parse(String(stdout.mock.lastCall![0]))).toMatchObject({ request: { clock: "source", edge: "end", at: "15" }, result: { status: "no-boundary" } });
      expect(process.exitCode).toBe(previous);
      await cli.parseAsync(["snap", join(dir, "missing"), "--at", "0", "--edge", "start", "--json"], { from: "user" });
      expect(JSON.parse(String(stdout.mock.lastCall![0])).result).toEqual({ status: "unavailable" });
      expect(process.exitCode).toBe(1);
    } finally { stdout.mockRestore(); process.exitCode = previous; }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
