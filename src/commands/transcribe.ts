import type { Command } from "commander";
import { transcribe, TranscribeCanceledError, TranscribeError, type TranscribeDependencies, type TranscribeOptions } from "../services/transcribe.js";

export function registerTranscribe(program: Command, dependencies: Partial<TranscribeDependencies> = {}): void {
  program.command("transcribe")
    .description("Write a private reference-grade context transcript from recording audio.")
    .argument("<input>", "local video or audio recording")
    .option("-o, --output <dir>", "output directory (default: beside the recording)")
    .option("--model <id>", "Gemini model ID")
    .option("--retention <policy>", "audio upload retention: provider (default) or run")
    .option("--keep-upload", "alias for --retention provider")
    .option("--delete-upload", "alias for --retention run")
    .option("--force", "replace existing transcript targets")
    .option("--json", "also write the transcript JSON with source-clock seconds")
    .action(async (input: string, flags: Omit<TranscribeOptions, "input">) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.on("SIGINT", cancel);
      try { await transcribe({ ...flags, input, signal: controller.signal }, dependencies); }
      catch (error) {
        // Provider and filesystem exception bodies may contain private content.
        const message = error instanceof TranscribeError ? error.message : "Transcription failed; check input, output permissions and provider access. See docs/RUNBOOK.md §3.11.";
        (dependencies.stderr ?? (line => { process.stderr.write(`${line}\n`); }))(`error: ${message}`);
        process.exitCode = error instanceof TranscribeCanceledError ? 130 : 1;
      } finally { process.off("SIGINT", cancel); }
    });
}
