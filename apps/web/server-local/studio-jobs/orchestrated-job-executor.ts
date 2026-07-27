import type {
  AnalysisJobExecutor,
  AnalysisJobExecutionResult,
} from "../../../../src/domain/studio-ports";
import {
  AnalysisExecutionIndeterminateError,
} from "../../../../src/domain/studio-ports";
import type {
  AnalysisJob,
} from "../../../../src/domain/studio-schemas";
import type {
  AnalysisJobStage,
} from "../../../../src/domain/studio-types";
import type {
  AnalysisOrchestrator,
  AnalysisProgressEvent,
  AnalysisProjectionPublisher,
  AnalyzeOptions,
} from "../../../../src/services/analyze";
import { digestRecipe } from "../../../../src/recipes/index";
import { validateRunImport } from "../../../../src/domain/integrity";
import {
  LocalInitialMediaGuard,
  LocalMediaReuseGuard,
  type LocalMediaReuseLease,
  StudioMediaReuseError,
} from "./media-reuse-guard";

interface AnalysisOrchestratorPort {
  analyze: AnalysisOrchestrator["analyze"];
}

export interface OrchestratedAnalysisJobExecutorOptions {
  orchestrator: AnalysisOrchestratorPort;
  resolveAnalyzeOptions(job: AnalysisJob): Promise<AnalyzeOptions>;
  projection?: AnalysisProjectionPublisher;
  initialMediaGuard?: LocalInitialMediaGuard;
  mediaReuseGuard?: LocalMediaReuseGuard;
  releaseContextFile?: (job: AnalysisJob) => Promise<void>;
  onContextFileReleaseError?: () => Promise<void> | void;
  onMediaLeaseReleaseError?: (
    error: StudioMediaReuseError,
  ) => Promise<void> | void;
  now?: () => string;
}

/**
 * Adapts immutable Studio job input to the shared analysis orchestrator.
 *
 * Media paths, context files, recipes, and process-memory secrets are resolved
 * just in time by the injected local factory. They never enter job events.
 */
export class OrchestratedAnalysisJobExecutor implements AnalysisJobExecutor {
  private readonly now: () => string;

  constructor(
    private readonly options: OrchestratedAnalysisJobExecutorOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async execute(
    job: AnalysisJob,
    execution: Parameters<AnalysisJobExecutor["execute"]>[1],
  ): Promise<AnalysisJobExecutionResult> {
    if (job.stage !== "fetching_context") {
      throw new Error("Orchestrated execution requires a claimed job.");
    }
    let mediaLease: LocalMediaReuseLease | undefined;
    if (job.retryOfJobId) {
      if (!this.options.mediaReuseGuard) {
        throw new StudioMediaReuseError("media_reuse_guard_required");
      }
      mediaLease = await this.options.mediaReuseGuard.acquire(job, this.now());
    } else {
      if (!this.options.initialMediaGuard) {
        throw new StudioMediaReuseError("media_initial_guard_required");
      }
      mediaLease = await this.options.initialMediaGuard.acquire(
        job.input,
        this.now(),
      );
    }
    try {
      const resolved = await this.options.resolveAnalyzeOptions(job);
      const analyzeOptions = await bindImmutableOptions(job, resolved);
      let currentStage: AnalysisJobStage = job.stage;
      const result = await this.options.orchestrator.analyze(analyzeOptions, {
        signal: execution.signal,
        ...(this.options.projection
          ? { projection: this.options.projection }
          : {}),
        progress: {
          report: async (event) => {
            currentStage = await this.persistProgress(
              job,
              currentStage,
              event,
              execution.progress,
            );
          },
        },
      });
      const validated = await validateRunImport({
        analysis: result.analysis,
        manifest: result.manifest,
      }).catch(() => {
        throw new AnalysisExecutionIndeterminateError();
      });
      return {
        runId: validated.analysis.runId,
        ...(result.projectionWarning
          ? { projectionWarning: result.projectionWarning }
          : {}),
      };
    } finally {
      await this.options.releaseContextFile?.(job).catch(async () => {
        if (this.options.onContextFileReleaseError) {
          await Promise.resolve(this.options.onContextFileReleaseError())
            .catch(() => undefined);
          return;
        }
        console.error("Local Studio context-file cleanup failed.", {
          code: "context_cleanup_failed",
        });
      });
      // A lease-release failure must not replace a valid publication receipt
      // or mask the original execution outcome. The lease retries once; this
      // reports a sanitized failure and startup reconciliation remains the
      // final repair path for an abandoned in_use receipt.
      await mediaLease?.release().catch(async () => {
        const failure = new StudioMediaReuseError(
          "media_lease_release_failed",
        );
        if (this.options.onMediaLeaseReleaseError) {
          await Promise.resolve(
            this.options.onMediaLeaseReleaseError(failure),
          )
            .catch(() => undefined);
          return;
        }
        console.error("Local Studio media lease release failed.", {
          code: failure.code,
        });
      });
    }
  }

  private async persistProgress(
    job: AnalysisJob,
    currentStage: AnalysisJobStage,
    event: AnalysisProgressEvent,
    progress: Parameters<AnalysisJobExecutor["execute"]>[1]["progress"],
  ): Promise<AnalysisJobStage> {
    const occurredAt = this.now();
    if (event.kind === "stage") {
      if (event.stage === currentStage) return currentStage;
      await progress.report({
        jobId: job.id,
        attempt: job.attempt,
        kind: "transition",
        previousStage: currentStage,
        stage: event.stage,
        occurredAt,
        message: event.message,
      });
      return event.stage;
    }
    if (event.kind === "progress") {
      await progress.report({
        jobId: job.id,
        attempt: job.attempt,
        kind: "progress",
        stage: event.stage,
        occurredAt,
        progress: event.progress,
        ...(event.message ? { message: event.message } : {}),
      });
    } else {
      await progress.report({
        jobId: job.id,
        attempt: job.attempt,
        kind: "warning",
        stage: event.stage,
        occurredAt,
        message: event.message,
      });
    }
    return currentStage;
  }
}

async function bindImmutableOptions(
  job: AnalysisJob,
  resolved: AnalyzeOptions,
): Promise<AnalyzeOptions> {
  if (
    resolved.recipe.id !== job.input.recipe.id
    || await digestRecipe(resolved.recipe) !== job.input.recipe.sha256
  ) {
    throw new Error(
      "Resolved recipe does not match the immutable job receipt.",
    );
  }
  const context = job.input.context;
  return {
    ...resolved,
    model: job.input.model,
    focus: job.input.focus,
    transcriptOffsetSeconds: job.input.transcriptOffsetSeconds,
    customRecipe: job.input.recipe.custom ?? resolved.customRecipe,
    recipeRevision: job.input.recipe.revision,
    recipeSha256: job.input.recipe.sha256,
    contextProvider: context.provider,
    ...(context.provider === "bluedot" || context.provider === "granola"
      ? { meetingId: context.meetingId }
      : {}),
    ...(context.provider === "granola"
      ? { granolaTransport: context.transport }
      : {}),
  };
}
