import { CliError, writeDocument } from "../cli-contract.js";
import { requireMedia } from "../services/media-capabilities.js";
import { exactTime, renderExactTimecode } from "exact-time";
import type { Command } from "commander";
import { DecodeError } from "../services/media-probe.js";
import { mediaHelper, type Helper, type MediaOptions } from "../services/media-helpers.js";

type MediaResult = Awaited<ReturnType<typeof mediaHelper>>;
function frameText(time: {clock: string; frames: string; rate: {num: number; den: number}}) {
  return `${time.clock} ${time.frames}f at ${time.rate.num}/${time.rate.den}`;
}
function describe(result: MediaResult) {
  if (result.kind === "verify") {
    return [`Expected ${frameText(result.expected)}`, `Measured ${frameText(result.actual)}`,
      `Decode ${result.decodeStatus}`, ...result.mismatches].join("\n");
  }
  if (result.kind === "frame") return `Frame ${frameText(result.at)} at ${result.width}×${result.height}. Decode ${result.decodeStatus}.`;
  const lines = [`Duration ${frameText(result.duration)}`, `Video ${result.width}×${result.height} ${result.codec}`,
    result.hasAudio ? `Audio ${result.audio.map(s => `${s.codec} (${s.channels} channels)`).join(", ")}` : "Audio absent",
    `Decode ${result.decodeStatus}`];
  if (result.fileStartLabel) {
    const {value, dropFrame} = result.fileStartLabel;
    const label = renderExactTimecode(exactTime(value.clock, value.frames, value.rate), dropFrame);
    lines.push(`File start label ${label} (${dropFrame ? "DF" : "NDF"})`);
  }
  if (result.kind === "slice") lines.push(`From ${frameText(result.from)} inclusive to ${frameText(result.to)} exclusive`);
  return lines.join("\n");
}

export function registerMedia(program: Command): void {
  function command(name: Helper, description: string) {
    return program.command(name).description(description).argument("<video>", "local recording")
      .option("--timecode-rate <spec>", "declare the exact rate and timecode mode")
      .option("--json", "print one JSON result")
      .action(async (video: string, flags: MediaOptions & {json?: boolean}) => {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.on("SIGINT", cancel);
        process.on("SIGTERM", cancel);
        try {
          await requireMedia(name, flags, controller.signal);
          const result = await mediaHelper(name, video, flags, controller.signal);
          if (flags.json) {
            if (result.kind === "verify" && result.mismatches.length) {
              throw new CliError("VERIFY_MISMATCH", `Expected ${result.expected.frames} frames, decoded ${result.actual.frames}.`);
            }
            writeDocument(result);
          } else process.stdout.write(describe(result) + "\n");
          if (result.kind === "verify" && result.mismatches.length) process.exitCode = 1;
        } catch (error) {
          if (flags.json && error instanceof DecodeError) throw new CliError("DECODE_FAILED", "Full media decode failed.");
          throw error;
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
        }
      });
  }
  function output(name: Helper, description: string) {
    return command(name, description).requiredOption("-o, --output <path>", "destination file")
      .option("--force", "replace a distinct existing regular output");
  }
  command("probe", "Measure local video frames, timing, streams and file start label.")
    .option("--decode-check", "fully decode primary video and audio");
  command("verify", "Fully decode and compare against one exact expectation.")
    .option("--expect-frames <count>", "expected whole video frame count")
    .option("--expect-duration <time>", "expected duration on the file clock");
  output("proxy", "Prepare a verified H.264 MP4 proxy with mono AAC reference audio.")
    .option("--height <pixels>", "even output height", "720")
    .option("--allow-oversize", "allow a local proxy above the upload size limit");
  output("slice", "Write a verified half-open source frame range to MP4.")
    .requiredOption("--from <time>", "inclusive source boundary")
    .requiredOption("--to <time>", "exclusive source boundary");
  output("frame", "Extract one full-resolution PNG or JPEG.")
    .requiredOption("--at <time>", "zero-based source frame");
}
