import { CliError, writeDocument } from "../cli-contract.js";
import { requireMedia } from "../services/media-capabilities.js";
import type { Command } from "commander";
import { parseSecondsMs } from "../domain/clock.js";
import { classify, describeMeasurement, describeSound, selectEdge, snapSettings } from "../domain/snap.js";
import { timestampToSeconds } from "../lib/time.js";
import { decodeSpeechEnvelope } from "../services/audio.js";

interface SnapFlags { at: string; edge: string; otherEdge?: string; fileClock?: string; json?: boolean }

function parseFileTime(time: string) {
  const elapsed = /^(\d+):([0-5]\d):([0-5]\d)(\.\d{1,3})?$/.exec(time);
  return parseSecondsMs(elapsed && time.trim() === time
    ? String(timestampToSeconds(`${elapsed[1]!.padStart(2, "0")}:${elapsed[2]}:${elapsed[3]}`)) + (elapsed[4] ?? "")
    : time);
}

export async function snapFile(video: string, flags: SnapFlags, decode = decodeSpeechEnvelope) {
  const clock = flags.fileClock ?? "source";
  if (clock !== "source" && clock !== "reel") throw new CliError("USAGE", "--file-clock must be source or reel.");
  if (flags.edge !== "start" && flags.edge !== "end") throw new CliError("USAGE", "--edge must be start or end.");
  const atMs = parseFileTime(flags.at);
  const otherEdgeMs = flags.otherEdge === undefined ? undefined : parseFileTime(flags.otherEdge);
  const settings = snapSettings();
  const pad = settings.windowMs + 15000 + settings.gapMs + 80;
  const left = Math.max(0, atMs - pad);
  const right = Math.min(Number.MAX_SAFE_INTEGER - 10, atMs + pad);
  const slice = { startMs: left - left % 10, endMs: right + (10 - right % 10) % 10 };
  const envelope = await decode(video, { slice, ...(flags.json && { reportFailure: true }) });
  const result = selectEdge(envelope && classify(envelope), flags.edge, atMs, clock, settings, otherEdgeMs);
  return { request: { clock, at: flags.at, edge: flags.edge, ...(flags.otherEdge !== undefined && { otherEdge: flags.otherEdge }) }, snapSettings: settings, result };
}

export function registerSnap(program: Command) {
  program.command("snap <video>").description("Measure a pause-bordered speech edge in a local recording.")
    .requiredOption("--at <time>", "Unsigned seconds or elapsed HH:MM:SS[.mmm]")
    .requiredOption("--edge <edge>", "start or end")
    .option("--other-edge <time>", "Opposite end of the pick, in the same file clock and time format as --at")
    .option("--file-clock <clock>", "source or reel", "source")
    .option("--json", "Print the request, settings and result as JSON")
    .action(async (video: string, flags: SnapFlags) => {
      await requireMedia("snap");
      const output = await snapFile(video, flags);
      const { request, result } = output;
      const reading = result.status === "snapped"
        ? ` · ${result.target.seconds} s (${describeMeasurement(result.target)}), shift ${result.shiftMs} ms, pause ${result.gapLowerBound ? "≥" : ""}${result.gapMs} ms · ${describeSound(result)}`
        : " · no measured precision";
      const alternatives = "alternativesMs" in result && result.alternativesMs.length
        ? ` · alternatives (ms): ${result.alternativesMs.join(", ")}` : "";
      if (flags.json) {
        writeDocument(output);
      } else process.stdout.write(`${request.clock} ${request.edge} ${request.at} · ${result.status}${reading}${alternatives}\n`);
      if (!flags.json && result.status === "unavailable") process.exitCode = 1;
    });
}
