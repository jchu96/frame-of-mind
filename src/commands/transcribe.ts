import { ContractError } from "../domain/contract-error.js";
import { KeyCommandRefused } from "../key-command.js";
import { cliSettings } from "../cli-settings.js";
import { CliError, writeDocument, writeFailure } from "../cli-contract.js";
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
    .option("--from <time>", "inclusive source time, frame or sample")
    .option("--to <time>", "exclusive source time, frame or sample")
    .option("--timecode-rate <rate>", "use the measured source rate with from-media:df or from-media:ndf")
    .option("-o, --output <dir>", "output directory (default: beside the recording)")
    .option("--transcript-language <tag>", "Likely spoken language (BCP-47)")
    .option("--model <id>", "Gemini model ID")
    .option("--retention <policy>", "audio upload retention: provider (default) or run")
    .option("--keep-upload", "alias for --retention provider")
    .option("--delete-upload", "alias for --retention run")
    .option("--force", "replace existing transcript targets")
    .option("--json", "write the transcript JSON with source-clock seconds and report the absolute paths of files written")
    .action(async (input: string, flags: Omit<TranscribeOptions, "input">) => {
      await requireMedia("transcribe");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.on("SIGINT", cancel);
      const diagnostic = dependencies.stderr ?? (line => { process.stderr.write(line + "\n"); });
      try {
        const config = cliSettings();
        const result = await transcribe({ ...flags, input, signal: controller.signal,
          apiKey: await config.providerKey() ?? "", model: flags.model ?? (config.setting("GEMINI_MODEL") || undefined) },
          flags.json ? { ...dependencies, stdout: diagnostic } : dependencies);
        if (flags.json) {
          const { paths, model, language, adjustedCues, blankCues, retention, tokens, quietLines } = result;
          writeDocument({
            ...result.source, paths, model, language, segmentCount: result.segments.length, adjustedCues, blankCues,
            quietLines, retention, ...(tokens && { tokens }),
          }, dependencies.stdout);
        }
      } catch (error) {
        if (error instanceof KeyCommandRefused) throw error;
        // Provider and filesystem exception bodies may contain private content.
        const message = error instanceof ContractError && error.code === "USAGE" ? error.message : error instanceof TranscribeError || error instanceof TranscriptLanguageError || error instanceof CliError ? error.message : "Transcription failed; check input, output permissions and provider access. See docs/RUNBOOK.md §3.11.";
        // A consumer reads this line; it stays on standard error in both modes.
        diagnostic(`error: ${message}`);
        if (error instanceof TranscribeError && error.diagnostic) diagnostic(error.diagnostic);
        if (flags.json) {
          writeFailure(error instanceof TranscriptLanguageError ? new CliError("USAGE", message) : error, dependencies.stdout);
          return;
        }
        process.exitCode = error instanceof TranscribeCanceledError || controller.signal.aborted ? 130 : (error instanceof CliError || error instanceof ContractError) && error.code === "USAGE" ? 2 : 1;
      } finally { process.off("SIGINT", cancel); }
    });
}
