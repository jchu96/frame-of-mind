import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { builtInRecipe, digestRecipe } from "../../../src/recipes/index.js";
import type {
  AnalysisDetail,
  IndexedMoment,
  MeetingEvidence,
} from "../../../src/domain/types.js";
import {
  HOSTED_PROVIDER_STEP_CONFIG,
  HOSTED_STATE_STEP_CONFIG,
  hostedWorkflowParametersSchema,
  type HostedAnalysisAttempt,
  type HostedWorkflowParameters,
  type SealedHostedMediaReceipt,
} from "./contracts.js";
import {
  createHostedAnalysisProvider,
  resolveHostedTranscript,
  type HostedAnalysisProvider,
  type HostedResolvedFile,
  type HostedTranscriptResult,
} from "./provider.js";
import {
  HostedRepositoryError,
  HostedWorkflowRepository,
} from "./repository.js";
import {
  buildHostedPublishedRun,
  publishHostedRun,
} from "./publication.js";

const MAX_WORKFLOW_OUTPUT_BYTES = 800 * 1_024;

interface Env {
  DB: D1Database;
  HOSTED_WORKFLOW: Workflow<HostedWorkflowParameters>;
  GEMINI_API_KEY?: string;
  HOSTED_FAKE_GEMINI?: string;
  HOSTED_FAKE_RECEIPT_FAILURE_MEDIA_ID?: string;
  HOSTED_FAKE_RECEIPT_FAILURE_STEP?: string;
  HOSTED_FAKE_START_DELAY_MEDIA_ID?: string;
}

interface HostedWorkflowOutput {
  attemptId: string;
  runId: string;
  acceptedCount: number;
}

export class HostedAnalysisWorkflow extends WorkflowEntrypoint<
  Env,
  HostedWorkflowParameters
> {
  override async run(
    event: Readonly<WorkflowEvent<HostedWorkflowParameters>>,
    step: WorkflowStep,
  ): Promise<HostedWorkflowOutput> {
    const parameters = hostedWorkflowParametersSchema.parse(event.payload);
    const repository = new HostedWorkflowRepository(this.env.DB);
    const attempt = await requireAttempt(repository, parameters);
    if (attempt.workflowInstanceId !== event.instanceId) {
      throw new NonRetryableError("workflow_instance_receipt_mismatch");
    }
    if (this.env.HOSTED_FAKE_START_DELAY_MEDIA_ID === attempt.input.mediaId) {
      await step.sleep("contract-start-delay", "1 second");
    }
    const provider = createHostedAnalysisProvider(this.env);
    let file: HostedResolvedFile | undefined;
    let meeting: MeetingEvidence | undefined;
    let transcript: HostedTranscriptResult | undefined;
    let indexed: {
      matchNotes: string;
      moments: IndexedMoment[];
      transcriptAlignment?: {
        offsetSeconds: number;
        confidence: "high" | "medium" | "low" | "none";
        rationale: string;
      };
    } | undefined;
    let details: AnalysisDetail[] | undefined;
    let runId: string | undefined;
    let acceptedCount = 0;
    let primaryError: unknown;

    try {
      meeting = await this.fetchContext(
        step,
        repository,
        provider,
        attempt,
      );
      const ensured = await this.ensureGeminiFile(
        step,
        repository,
        provider,
        attempt,
      );
      file = ensured.file;
      transcript = await this.transcribe(
        step,
        repository,
        provider,
        attempt,
        meeting,
        file,
      );
      indexed = await this.index(
        step,
        repository,
        provider,
        attempt,
        meeting,
        transcript,
        file,
      );
      details = await this.interrogate(
        step,
        repository,
        provider,
        attempt,
        indexed.moments,
        transcript,
        file,
      );
      acceptedCount = details.filter((detail) => detail.accepted).length;
    } catch (error) {
      primaryError = error;
    }

    let cleanupError: unknown;
    let cleanup: { deleted: boolean; completedAt: string } | undefined;
    try {
      cleanup = await this.cleanup(
        step,
        repository,
        provider,
        attempt,
        file,
      );
    } catch (error) {
      cleanupError = error;
    }

    if (
      !primaryError
      && !cleanupError
      && cleanup
      && file
      && transcript
      && indexed
      && details
    ) {
      try {
        const published = await this.publish(
          step,
          repository,
          attempt,
          meeting,
          transcript,
          indexed,
          details,
          file,
          cleanup,
        );
        runId = published.runId;
      } catch (error) {
        primaryError = error;
      }
    }

    const finishedAt = new Date().toISOString();
    if (primaryError || cleanupError) {
      const latestAttempt = await repository.getAttempt(
        attempt.principalSub,
        attempt.attemptId,
      );
      const terminal = latestAttempt?.cancellationRequestedAt && !cleanupError
        ? { stage: "canceled" as const, code: "operator_canceled" }
        : terminalFailure(primaryError, cleanupError);
      await repository.finishAttempt({
        principalSub: attempt.principalSub,
        attemptId: attempt.attemptId,
        stage: terminal.stage,
        occurredAt: finishedAt,
        errorCode: terminal.code,
        cleanupCompleted: !cleanupError,
      });
      throw new NonRetryableError(terminal.code);
    }
    if (!runId) {
      await repository.finishAttempt({
        principalSub: attempt.principalSub,
        attemptId: attempt.attemptId,
        stage: "indeterminate",
        occurredAt: finishedAt,
        errorCode: "publish_receipt_missing",
        cleanupCompleted: true,
      });
      throw new NonRetryableError("publish_receipt_missing");
    }
    await repository.finishAttempt({
      principalSub: attempt.principalSub,
      attemptId: attempt.attemptId,
      stage: "succeeded",
      occurredAt: finishedAt,
      runId,
      cleanupCompleted: true,
    });
    return { attemptId: attempt.attemptId, runId, acceptedCount };
  }

  private async fetchContext(
    step: WorkflowStep,
    repository: HostedWorkflowRepository,
    provider: HostedAnalysisProvider,
    attempt: HostedAnalysisAttempt,
  ): Promise<MeetingEvidence | undefined> {
    if ("mode" in attempt.input.context) {
      return await step.do(
        "fetch_context",
        HOSTED_STATE_STEP_CONFIG,
        async () => {
          await beginStep(repository, attempt, "fetch_context");
          await repository.assertNotCanceled(attempt.principalSub, attempt.attemptId);
          await repository.putReceipt(
            attempt.principalSub,
            attempt.attemptId,
            "fetch_context",
            { contextMode: "none" },
            new Date().toISOString(),
          );
          return undefined;
        },
      );
    }
    return await providerStep({
      step,
      repository,
      providerStepName: "fetch_context",
      stage: "fetch_context",
      eventCode: "context_fetch_started",
      attempt,
      env: this.env,
      invoke: async () => sanitizeMeeting(await provider.fetchContext(attempt)),
    });
  }

  private async ensureGeminiFile(
    step: WorkflowStep,
    repository: HostedWorkflowRepository,
    provider: HostedAnalysisProvider,
    attempt: HostedAnalysisAttempt,
  ): Promise<{
    file: HostedResolvedFile;
    receipt: SealedHostedMediaReceipt;
  }> {
    const receipt = await repository.requireUsableMediaReceipt(
      attempt.principalSub,
      attempt.input.mediaId,
      new Date().toISOString(),
    );
    if (receipt.sha256 !== attempt.input.mediaSha256) {
      throw new NonRetryableError("sealed_media_receipt_mismatch");
    }
    const file = await providerStep({
      step,
      repository,
      providerStepName: "ensure_gemini_file",
      stage: "ensure_gemini_file",
      eventCode: "gemini_file_resolve_started",
      attempt,
      env: this.env,
      invoke: () => provider.ensureGeminiFile(receipt),
    });
    return { file, receipt };
  }

  private async transcribe(
    step: WorkflowStep,
    repository: HostedWorkflowRepository,
    provider: HostedAnalysisProvider,
    attempt: HostedAnalysisAttempt,
    meeting: MeetingEvidence | undefined,
    file: HostedResolvedFile,
  ): Promise<HostedTranscriptResult> {
    const contextual = resolveHostedTranscript({ meeting });
    if (contextual.origin !== "none") {
      return await step.do(
        "transcribe",
        HOSTED_STATE_STEP_CONFIG,
        async () => {
          await beginStep(repository, attempt, "transcribe");
          await repository.assertNotCanceled(attempt.principalSub, attempt.attemptId);
          await repository.putReceipt(
            attempt.principalSub,
            attempt.attemptId,
            "transcribe",
            {
              origin: contextual.origin,
              bytes: new TextEncoder().encode(contextual.text ?? "").byteLength,
            },
            new Date().toISOString(),
          );
          return boundedOutput(contextual);
        },
      );
    }
    try {
      const segments = await providerStep({
        step,
        repository,
        providerStepName: "transcribe",
        stage: "transcribe",
        eventCode: "gemini_transcribe_started",
        attempt,
        env: this.env,
        invoke: () => provider.transcribe(file),
      });
      return boundedOutput(resolveHostedTranscript({
        meeting,
        derivedSegments: segments,
      }));
    } catch (error) {
      if (
        error instanceof NonRetryableError
        || errorMessage(error) === "provider_success_without_receipt"
      ) {
        throw error;
      }
      await repository.appendEvent(
        attempt.principalSub,
        attempt.attemptId,
        "warning",
        "gemini_transcript_unavailable",
        new Date().toISOString(),
      );
      return { origin: "none" };
    }
  }

  private async index(
    step: WorkflowStep,
    repository: HostedWorkflowRepository,
    provider: HostedAnalysisProvider,
    attempt: HostedAnalysisAttempt,
    meeting: MeetingEvidence | undefined,
    transcript: HostedTranscriptResult,
    file: HostedResolvedFile,
  ): Promise<{
    matchNotes: string;
    moments: IndexedMoment[];
    transcriptAlignment?: {
      offsetSeconds: number;
      confidence: "high" | "medium" | "low" | "none";
      rationale: string;
    };
  }> {
    const recipe = await requireRecipe(attempt);
    const indexed = await providerStep({
      step,
      repository,
      providerStepName: "index",
      stage: "index",
      eventCode: "gemini_index_started",
      attempt,
      env: this.env,
      invoke: () => provider.index({
        file,
        meeting,
        transcript,
        recipe,
        ...(attempt.input.focus ? { focus: attempt.input.focus } : {}),
      }),
    });
    return boundedOutput({
      matchNotes: indexed.matchNotes,
      moments: indexed.moments,
    });
  }

  private async interrogate(
    step: WorkflowStep,
    repository: HostedWorkflowRepository,
    provider: HostedAnalysisProvider,
    attempt: HostedAnalysisAttempt,
    moments: IndexedMoment[],
    transcript: HostedTranscriptResult,
    file: HostedResolvedFile,
  ): Promise<AnalysisDetail[]> {
    await step.do("interrogate", HOSTED_STATE_STEP_CONFIG, async () => {
      await beginStep(repository, attempt, "interrogate");
      await repository.assertNotCanceled(attempt.principalSub, attempt.attemptId);
      await repository.putReceipt(
        attempt.principalSub,
        attempt.attemptId,
        "interrogate",
        { candidateCount: moments.length },
        new Date().toISOString(),
      );
      return { candidateCount: moments.length };
    });
    const recipe = await requireRecipe(attempt);
    const details: AnalysisDetail[] = [];
    for (const [index, candidate] of moments.entries()) {
      const stepName = `interrogate_${String(index + 1).padStart(4, "0")}`;
      details.push(await providerStep({
        step,
        repository,
        providerStepName: stepName,
        stage: "interrogate",
        eventCode: "gemini_interrogate_started",
        attempt,
        env: this.env,
        invoke: () => provider.interrogate({
          file,
          candidate,
          transcript,
          recipe,
          ...(attempt.input.focus ? { focus: attempt.input.focus } : {}),
        }),
      }));
    }
    return details;
  }

  private async publish(
    step: WorkflowStep,
    repository: HostedWorkflowRepository,
    attempt: HostedAnalysisAttempt,
    meeting: MeetingEvidence | undefined,
    transcript: HostedTranscriptResult,
    indexed: {
      matchNotes: string;
      moments: IndexedMoment[];
      transcriptAlignment?: {
        offsetSeconds: number;
        confidence: "high" | "medium" | "low" | "none";
        rationale: string;
      };
    },
    details: AnalysisDetail[],
    file: HostedResolvedFile,
    cleanup: { deleted: boolean; completedAt: string },
  ): Promise<{ runId: string }> {
    return await step.do("publish", HOSTED_STATE_STEP_CONFIG, async () => {
      await beginStep(repository, attempt, "publish");
      await repository.assertNotCanceled(attempt.principalSub, attempt.attemptId);
      const publishedAt = new Date().toISOString();
      const pair = await buildHostedPublishedRun({
        attempt,
        meeting,
        transcript,
        ...(indexed.transcriptAlignment
          ? { transcriptAlignment: indexed.transcriptAlignment }
          : {}),
        matchNotes: indexed.matchNotes,
        moments: indexed.moments,
        details,
        file,
        cleanup,
        publishedAt,
      });
      const projected = await publishHostedRun(
        this.env.DB,
        attempt.principalSub,
        pair,
      );
      await repository.putReceipt(
        attempt.principalSub,
        attempt.attemptId,
        "publish",
        {
          runId: projected.runId,
          analysisSha256: pair.manifest.analysisSha256,
          manifestSha256: await sha256(JSON.stringify(pair.manifest)),
          mediaSha256: attempt.input.mediaSha256,
          model: attempt.input.model,
          contextMode: pair.analysis.schemaVersion === 3 ? "none" : "meeting",
          acceptedCount: details.filter((detail) => detail.accepted).length,
          rejectedCount: details.filter((detail) => !detail.accepted).length,
        },
        publishedAt,
      );
      return { runId: projected.runId };
    });
  }

  private async cleanup(
    step: WorkflowStep,
    repository: HostedWorkflowRepository,
    provider: HostedAnalysisProvider,
    attempt: HostedAnalysisAttempt,
    resolvedFile: HostedResolvedFile | undefined,
  ): Promise<{ deleted: boolean; completedAt: string }> {
    const receipt = await repository.requireUsableMediaReceipt(
      attempt.principalSub,
      attempt.input.mediaId,
      attempt.createdAt,
    );
    const file = resolvedFile ?? {
      name: receipt.geminiFileName,
      uri: receipt.geminiFileUri,
      mimeType: receipt.mimeType,
    };
    const result = await providerStep({
      step,
      repository,
      providerStepName: "cleanup",
      stage: "cleanup",
      eventCode: "gemini_cleanup_started",
      attempt,
      env: this.env,
      allowCancellation: true,
      invoke: async () => {
        await provider.cleanup(file, receipt);
        return { deleted: receipt.retention === "ephemeral" };
      },
    });
    return {
      deleted: result.deleted,
      completedAt: new Date().toISOString(),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "frame-of-mind-hosted-workflows" });
    }
    if (request.method !== "POST" || url.pathname !== "/attempts/dispatch") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 8_192) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const parsed = hostedWorkflowParametersSchema.safeParse(
      (() => {
        try {
          return JSON.parse(rawBody);
        } catch {
          return undefined;
        }
      })(),
    );
    if (!parsed.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const repository = new HostedWorkflowRepository(env.DB);
    const attempt = await repository.getAttempt(
      parsed.data.principalSub,
      parsed.data.attemptId,
    );
    if (!attempt || attempt.stage !== "queued") {
      if (attempt) {
        return Response.json({
          attemptId: attempt.attemptId,
          workflowInstanceId: attempt.workflowInstanceId,
          replayed: true,
        });
      }
      return Response.json({ error: "attempt_not_found" }, { status: 404 });
    }
    try {
      await env.HOSTED_WORKFLOW.create({
        id: attempt.workflowInstanceId,
        params: parsed.data,
      });
      return Response.json({
        attemptId: attempt.attemptId,
        workflowInstanceId: attempt.workflowInstanceId,
        replayed: false,
      }, { status: 201 });
    } catch {
      try {
        const instance = await env.HOSTED_WORKFLOW.get(attempt.workflowInstanceId);
        await instance.status();
        return Response.json({
          attemptId: attempt.attemptId,
          workflowInstanceId: attempt.workflowInstanceId,
          replayed: true,
        });
      } catch {
        return Response.json({ error: "workflow_dispatch_failed" }, { status: 503 });
      }
    }
  },
} satisfies ExportedHandler<Env>;

async function providerStep<T>(input: {
  step: WorkflowStep;
  repository: HostedWorkflowRepository;
  providerStepName: string;
  stage: HostedAnalysisAttempt["stage"];
  eventCode: string;
  attempt: HostedAnalysisAttempt;
  env: Env;
  allowCancellation?: boolean;
  invoke(): Promise<T>;
}): Promise<T> {
  const result = await input.step.do(
    input.providerStepName,
    HOSTED_PROVIDER_STEP_CONFIG,
    async (): Promise<any> => {
      await beginStep(input.repository, input.attempt, input.stage);
      let providerSucceeded = false;
      try {
        const receipt = await input.repository.requireUsableMediaReceipt(
          input.attempt.principalSub,
          input.attempt.input.mediaId,
          new Date().toISOString(),
        );
        if (receipt.sha256 !== input.attempt.input.mediaSha256) {
          throw new NonRetryableError("sealed_media_receipt_mismatch");
        }
        if (!input.allowCancellation) {
          await input.repository.assertNotCanceled(
            input.attempt.principalSub,
            input.attempt.attemptId,
          );
        }
        const existing = await input.repository.getReceipt(
          input.attempt.principalSub,
          input.attempt.attemptId,
          input.providerStepName,
        );
        if (existing) {
          if (input.providerStepName === "cleanup") {
            return {
              status: "ok",
              output: { deleted: receipt.retention === "ephemeral" },
            };
          }
          throw new NonRetryableError("provider_receipt_without_step_output");
        }
        const claimed = await input.repository.claimProviderCall(
          input.attempt.principalSub,
          input.attempt.attemptId,
          input.providerStepName,
          input.eventCode,
          new Date().toISOString(),
        );
        if (!claimed) {
          await input.repository.appendEvent(
            input.attempt.principalSub,
            input.attempt.attemptId,
            "provider_reentry_blocked",
            "provider_claim_without_receipt",
            new Date().toISOString(),
          );
          throw new NonRetryableError("provider_success_without_receipt");
        }
        const invoked = await input.invoke();
        providerSucceeded = true;
        const output = boundedOutput(invoked);
        await input.repository.appendEvent(
          input.attempt.principalSub,
          input.attempt.attemptId,
          "provider_success",
          input.eventCode.replace(/_started$/, "_succeeded"),
          new Date().toISOString(),
        );
        if (
          input.env.HOSTED_FAKE_RECEIPT_FAILURE_MEDIA_ID
            === input.attempt.input.mediaId
          && input.env.HOSTED_FAKE_RECEIPT_FAILURE_STEP
            === input.providerStepName
        ) {
          throw new Error("provider_success_without_receipt");
        }
        const json = JSON.stringify(output);
        await input.repository.putReceipt(
          input.attempt.principalSub,
          input.attempt.attemptId,
          input.providerStepName,
          {
            outputSha256: await sha256(json),
            outputBytes: new TextEncoder().encode(json).byteLength,
          },
          new Date().toISOString(),
        );
        return { status: "ok", output };
      } catch (error) {
        if (providerSucceeded) {
          throw new Error("provider_success_without_receipt");
        }
        if (error instanceof NonRetryableError) {
          return { status: "indeterminate", code: safeErrorCode(error.message) };
        }
        if (error instanceof HostedRepositoryError) {
          return { status: "repository_error", code: error.code };
        }
        return { status: "provider_error", code: "provider_call_failed" };
      }
    },
  );
  const durableReceipt = await input.repository.getReceipt(
    input.attempt.principalSub,
    input.attempt.attemptId,
    input.providerStepName,
  );
  if (
    !durableReceipt
    && await input.repository.hasProviderClaim(
      input.attempt.principalSub,
      input.attempt.attemptId,
      input.providerStepName,
    )
  ) {
    throw new NonRetryableError("provider_success_without_receipt");
  }
  if (result.status === "indeterminate") {
    throw new NonRetryableError(result.code);
  }
  if (result.status === "repository_error") {
    throw new HostedRepositoryError(result.code);
  }
  if (result.status === "provider_error") {
    throw new Error(result.code);
  }
  return result.output as T;
}

async function beginStep(
  repository: HostedWorkflowRepository,
  attempt: HostedAnalysisAttempt,
  stage: HostedAnalysisAttempt["stage"],
): Promise<void> {
  await repository.beginStage(
    attempt.principalSub,
    attempt.attemptId,
    stage,
    new Date().toISOString(),
  );
}

async function requireAttempt(
  repository: HostedWorkflowRepository,
  parameters: HostedWorkflowParameters,
): Promise<HostedAnalysisAttempt> {
  const attempt = await repository.getAttempt(
    parameters.principalSub,
    parameters.attemptId,
  );
  if (!attempt) throw new NonRetryableError("hosted_attempt_not_found");
  return attempt;
}

async function requireRecipe(attempt: HostedAnalysisAttempt) {
  const recipe = builtInRecipe(attempt.input.recipe.id);
  if (
    recipe.label !== attempt.input.recipe.label
    || await digestRecipe(recipe) !== attempt.input.recipe.sha256
  ) {
    throw new NonRetryableError("recipe_receipt_mismatch");
  }
  return recipe;
}

function sanitizeMeeting(
  meeting: MeetingEvidence | undefined,
): MeetingEvidence | undefined {
  if (!meeting) return undefined;
  const sanitized: MeetingEvidence = {
    id: meeting.id,
    provider: meeting.provider,
    transport: meeting.transport,
    transcript: meeting.transcript.slice(0, 512 * 1_024),
    raw: null,
    ...(meeting.title ? { title: meeting.title.slice(0, 500) } : {}),
    ...(meeting.createdAt ? { createdAt: meeting.createdAt } : {}),
  };
  return boundedOutput(sanitized);
}

function boundedOutput<T>(value: T): T {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_WORKFLOW_OUTPUT_BYTES) {
    throw new NonRetryableError("workflow_step_output_too_large");
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function terminalFailure(
  primaryError: unknown,
  cleanupError: unknown,
): {
  stage: "failed" | "canceled" | "indeterminate";
  code: string;
} {
  if (cleanupError) return { stage: "failed", code: "terminal_cleanup_failed" };
  if (errorMessage(primaryError) === "operator_canceled") {
    return { stage: "canceled", code: "operator_canceled" };
  }
  if (primaryError instanceof HostedRepositoryError) {
    if (primaryError.code === "operator_canceled") {
      return { stage: "canceled", code: primaryError.code };
    }
    return { stage: "failed", code: primaryError.code };
  }
  if (primaryError instanceof NonRetryableError) {
    const code = primaryError.message === "provider_success_without_receipt"
      ? "provider_receipt_indeterminate"
      : safeErrorCode(primaryError.message);
    return { stage: "indeterminate", code };
  }
  if (errorMessage(primaryError) === "provider_success_without_receipt") {
    return { stage: "indeterminate", code: "provider_receipt_indeterminate" };
  }
  return { stage: "failed", code: "hosted_workflow_failed" };
}

function safeErrorCode(message: string): string {
  return /^[a-z0-9_:-]{1,120}$/.test(message)
    ? message
    : "hosted_workflow_failed";
}

function errorMessage(error: unknown): string | undefined {
  return error && typeof error === "object" && "message" in error
    && typeof error.message === "string"
    ? error.message
    : undefined;
}
