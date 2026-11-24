import { writeDocument } from "../cli-contract.js";
import type { Command } from "commander";
import { describeMap, mapTimeline, type MapOptions } from "../services/timeline-map.js";

export function registerMap(program: Command) {
  program.command("map <timeline>").description("Map a sequence time to source frames, or find uses of a source frame.")
    .option("--at <time>", "Sequence frame (Nf), decimal seconds at a frame boundary, or sequence timecode")
    .option("--source <path>", "Local source media path for reverse lookup")
    .option("--frame <n>", "Whole frame value as written in the timeline's media reference clock")
    .option("--track <n>", "Video track number, counting from one at the bottom")
    .option("--timecode-rate <rate>", "Declare the sequence rate and timecode mode")
    .option("--video <path>", "Read sequence startTimecode metadata from the exported video")
    .option("--json", "Print the lookup as JSON")
    .action(async (timeline: string, flags: MapOptions & { json?: boolean }) => {
      const output = await mapTimeline(timeline, flags);
      if (flags.json) {
        for (const warning of output.mode.notes) process.stderr.write(warning + "\n");
        writeDocument({ ...output, mode: { ...output.mode, notes: [] } });
      } else process.stdout.write(describeMap(output) + "\n");
    });
}
