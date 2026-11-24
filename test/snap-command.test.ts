import { validateCliDocument } from "./helpers/cli-schema.js";
import { Command } from "commander";
import { expect, test, vi } from "vitest";
import { registerSnap, snapFile } from "../src/commands/snap.js";
import * as audio from "../src/services/audio.js";

vi.mock("../src/services/media-capabilities.js", () => ({ requireMedia: async () => {} }));

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

test("snap rounds bounded decoder requests outward on the file grid", async () => {
  const decode = vi.fn<typeof audio.decodeSpeechEnvelope>(async () => undefined);
  for (const at of ["00:00:41.007", "1.410"]) await snapFile("generated", {at, edge: "end"}, decode);
  expect(decode.mock.calls.map(call => call[1]?.slice)).toEqual([{ startMs: 24170, endMs: 57840 }, { startMs: 0, endMs: 18240 }]);
});

test("snap reports measured precision, no boundary and unavailable decode at the command", async () => {
  const blocks = [new Float32Array(1000).fill(-96)];
  blocks[0]!.fill(-9, 100, 150);
  const decode = vi.spyOn(audio, "decodeSpeechEnvelope").mockResolvedValue({blocks, length: 1000, startMs: 0, sourceSampleRateHz: 48000});
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const previous = process.exitCode;
  try {
    const cli = new Command();
    registerSnap(cli);
    await cli.parseAsync(["snap", "generated", "--at", "1.410", "--edge", "end", "--file-clock", "reel"], { from: "user" });
    expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/reel end 1\.410 · snapped.*measured on a 10 ms grid, accurate to about ±50 ms/));
    await cli.parseAsync(["snap", "generated", "--at", "15", "--edge", "end", "--json"], { from: "user" });
    expect(validateCliDocument("snap", String(stdout.mock.lastCall![0]))).toMatchObject({ request: { clock: "source", edge: "end", at: "15" }, result: { status: "no-boundary" } });
    expect(process.exitCode).toBe(previous);
    decode.mockResolvedValue(undefined);
    await cli.parseAsync(["snap", "empty", "--at", "0", "--edge", "start", "--json"], { from: "user" });
    expect(validateCliDocument("snap", String(stdout.mock.lastCall![0])).result.status).toBe("unavailable");
    expect(process.exitCode).toBe(previous);
  } finally { decode.mockRestore(); stdout.mockRestore(); process.exitCode = previous; }
});
