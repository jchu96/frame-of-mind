import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnalysisJob } from "../../../../src/domain/studio-schemas";
import {
  validateVersionedRunImport,
} from "../../../../src/domain/integrity";
import { safePathSegment } from "../../../../src/lib/files";
import type { RunStore } from "../../server/data/types";

const MAXIMUM_RUN_PAIR_BYTES = 2 * 1_024 * 1_024;

export class StudioRunReimportError extends Error {
  constructor(readonly code: string) {
    super("Local Studio run re-import failed.");
    this.name = "StudioRunReimportError";
  }
}

export async function reimportPublishedJobRun(input: {
  job: AnalysisJob;
  outputRoot: string;
  store: RunStore;
}): Promise<{ runId: string; created: boolean }> {
  if (input.job.stage !== "succeeded" || !input.job.runId) {
    throw new StudioRunReimportError("job_not_succeeded");
  }
  const directory = publishedRunDirectory(input.job, input.outputRoot);
  let analysisText: string;
  let manifestText: string;
  try {
    const [analysisStats, manifestStats] = await Promise.all([
      stat(join(directory, "analysis.json")),
      stat(join(directory, "manifest.json")),
    ]);
    if (
      !analysisStats.isFile()
      || !manifestStats.isFile()
      || analysisStats.size + manifestStats.size > MAXIMUM_RUN_PAIR_BYTES
    ) {
      throw new StudioRunReimportError("run_bundle_invalid");
    }
    [analysisText, manifestText] = await Promise.all([
      readFile(join(directory, "analysis.json"), "utf8"),
      readFile(join(directory, "manifest.json"), "utf8"),
    ]);
  } catch (error) {
    if (error instanceof StudioRunReimportError) throw error;
    throw new StudioRunReimportError("run_bundle_not_found");
  }
  // The sanitized coverage outcome is auxiliary: reimport carries it when the
  // bundle has one (bounded by the same pair budget) but never fails a run
  // whose bundle predates it.
  let outcomeText: string | undefined;
  try {
    const outcomeStats = await stat(join(directory, "analysis-outcome.json"));
    if (outcomeStats.isFile() && outcomeStats.size <= MAXIMUM_RUN_PAIR_BYTES) {
      outcomeText = await readFile(join(directory, "analysis-outcome.json"), "utf8");
    }
  } catch {
    // Absent outcome artifact: legacy bundle, import the pair alone.
  }

  let run;
  try {
    run = await validateVersionedRunImport({
      analysis: JSON.parse(analysisText),
      manifest: JSON.parse(manifestText),
      ...(outcomeText !== undefined ? { outcome: JSON.parse(outcomeText) } : {}),
    });
  } catch {
    throw new StudioRunReimportError("run_bundle_invalid");
  }
  if (
    run.analysis.runId !== input.job.runId
    || run.manifest.runId !== input.job.runId
  ) {
    throw new StudioRunReimportError("run_bundle_job_mismatch");
  }
  return input.store.importRun(run);
}

export function publishedRunDirectory(
  job: AnalysisJob,
  outputRoot: string,
): string {
  if (!job.runId) throw new StudioRunReimportError("job_not_succeeded");
  const context = job.input.context;
  const containerId = "mode" in context
    ? `video-${job.input.mediaSha256.slice(0, 16)}`
    : context.provider === "file"
      ? context.contextFileId
      : context.meetingId;
  return join(
    resolve(outputRoot),
    safePathSegment(containerId),
    safePathSegment(job.runId),
  );
}
