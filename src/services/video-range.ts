import { exactTime } from "exact-time";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createScratch, discardRangeAttempt, rangeEncoder, releaseRangeScratch } from "../adapters/scratch.js";
import { faultCode } from "../domain/contract-error.js";
import type { RangeRequest } from "../domain/range-clock.js";
import { UnprovenCut } from "./avc-samples.js";
import { encodeVideoRange } from "./media-helpers.js";
import { decodeVideo, inspectVideo } from "./media-probe.js";
import { localRecording } from "./media-tools.js";
import { decodeBudget, scanRange, type VideoSelection } from "./range-scan.js";

export async function withVideoRange<T>(
  path: string, request: RangeRequest, dropFrame: boolean | undefined,
  tell: (line: string) => void, signal: AbortSignal | undefined,
  consume: (file: string, selection: VideoSelection) => Promise<T>,
  beforeCut?: (selection: VideoSelection) => void,
) {
  const input = await localRecording(path);
  let range = `${request.from ?? "0"},${request.to ?? "EOF"}`;
  let mode = "seek", phase = "scanning packets";
  const progress = () => tell(`Cutting source [${range}): ${mode} — ${phase}`);
  const setPhase = (value: string) => { phase = value; progress(); };
  progress();
  const timer = setInterval(progress, 30000);
  timer.unref();
  const scratch = await createScratch("range").catch(error => { clearInterval(timer); throw error; });
  const file = join(scratch, "cut.mp4");
  try {
    const selection = await scanRange(input, request, dropFrame, signal, reason => { mode = "whole-file"; setPhase(reason); });
    const {clock} = selection;
    tell(clock.rangeLine());
    range = `${clock.from},${clock.to}`;
    beforeCut?.(selection);
    const from = exactTime("source", String(clock.from), clock.grid.rate);
    const to = exactTime("source", String(clock.to), clock.grid.rate);
    const encode = async () => {
      await (await open(file, "wx", 0o600)).close();
      await encodeVideoRange(input, file, selection.info, from, to, {width: selection.info.width, height: selection.info.height},
        signal, selection.seek, setPhase, rangeEncoder(file));
    };
    let rescan = false;
    if (selection.seek) {
      setPhase("encoding from IDR");
      try { await encode(); }
      catch (error) {
        const code = faultCode(error);
        const reason = error instanceof UnprovenCut ? error.message
          : ["DECODE_FAILED", "INVALID_RATE", "INVALID_TIMECODE"].includes(code) ? "could not verify seek cut" : undefined;
        if (!reason) throw error;
        rescan = true;
        selection.reason = reason;
        selection.seek = undefined;
        discardRangeAttempt(file);
      }
    }
    if (!selection.seek) {
      mode = "whole-file";
      setPhase(selection.reason!);
      if (rescan) selection.info = await inspectVideo(input, {dropFrame}, signal, decodeBudget(selection.info.approximateSeconds));
      await decodeVideo(input, selection.info, signal, decodeBudget(selection.info.approximateSeconds));
      setPhase("encoding verified range");
      await encode();
    }
    await input.check();
    clearInterval(timer);
    signal?.throwIfAborted();
    return await consume(file, selection);
  } finally {
    clearInterval(timer);
    await releaseRangeScratch(scratch);
  }
}
