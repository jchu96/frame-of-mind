import { requireMedia } from "../services/media-capabilities.js";
import type { Command } from "commander";
import { TranscriptLanguageError } from "../domain/transcript-language.js";
import { transcribe, TranscribeCanceledError, TranscribeError, type TranscribeDependencies, type TranscribeOptions } from "../services/transcribe.js";

export const transcriptionHelp = [
  "",
  "Transcription requests the original spoken languages, including mid-sentence switches, and forbids translation.",
  "Use --transcript-language <tag> to hint at likely speech during transcription only. On analyze, --note language=<path> guides analysis prompts only.",
  "Speaker 1, [inaudible] and [crosstalk] are transcript format markers for speech in any language.",
  "The CLI and local Studio use the first audio track. Hosted Studio sends the resolved media.",
  "Live transcription fidelity on real non-English speech is untested.",
].join("\n");

export function registerTranscribe(program: Command, dependencies: Partial<TranscribeDependencies> = {}): void {
  program.command("transcribe")
    .description("Write a private reference-grade context transcript from recording audio.")
    .addHelpText("after", transcriptionHelp)
    .argument("<input>", "local video or audio recording")
    .option("-o, --output <dir>", "output directory (default: beside the recording)")
    .option("--transcript-language <tag>", "Likely spoken language (BCP-47)")
    .option("--model <id>", "Gemini model ID")
    .option("--retention <policy>", "audio upload retention: provider (default) or run")
    .option("--keep-upload", "alias for --retention provider")
    .option("--delete-upload", "alias for --retention run")
    .option("--force", "replace existing transcript targets")
    .option("--json", "also write the transcript JSON with source-clock seconds")
    .action(async (input: string, flags: Omit<TranscribeOptions, "input">) => {
      await requireMedia("transcribe");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.on("SIGINT", cancel);
      try { await transcribe({ ...flags, input, signal: controller.signal }, dependencies); }
      catch (error) {
        // Provider and filesystem exception bodies may contain private content.
        const message = error instanceof TranscribeError || error instanceof TranscriptLanguageError ? error.message : "Transcription failed; check input, output permissions and provider access. See docs/RUNBOOK.md §3.11.";
        (dependencies.stderr ?? (line => { process.stderr.write(`${line}\n`); }))(`error: ${message}`);
        process.exitCode = error instanceof TranscribeCanceledError ? 130 : 1;
      } finally { process.off("SIGINT", cancel); }
    });
}
