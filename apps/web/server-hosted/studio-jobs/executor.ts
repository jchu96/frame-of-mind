import type { H3Event } from "h3";
import {
  AnalysisExecutionIndeterminateError,
  type AnalysisJobExecutor,
} from "../../../../src/domain/studio-ports.js";
import {
  isHostedAttemptTerminal,
  type HostedDispatchReceipt,
} from "../../../workflows/src/contracts.js";
import { HostedWorkflowRepository } from "../../../workflows/src/repository.js";

export interface HostedWorkflowServiceBinding {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export class HostedWorkflowAnalysisJobExecutor implements AnalysisJobExecutor {
  constructor(
    private readonly repository: HostedWorkflowRepository,
    private readonly service: HostedWorkflowServiceBinding,
    private readonly principalSub: string,
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async dispatch(attemptId: string): Promise<HostedDispatchReceipt> {
    const response = await this.service.fetch(
      "http://hosted-workflows.internal/attempts/dispatch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principalSub: this.principalSub,
          attemptId,
        }),
      },
    );
    if (!response.ok) {
      throw new HostedWorkflowDispatchError("hosted_workflow_dispatch_failed");
    }
    const body = await response.json().catch(() => undefined) as
      | Partial<HostedDispatchReceipt>
      | undefined;
    if (
      typeof body?.attemptId !== "string"
      || typeof body.workflowInstanceId !== "string"
      || typeof body.replayed !== "boolean"
      || body.attemptId !== attemptId
    ) {
      throw new HostedWorkflowDispatchError("hosted_workflow_dispatch_invalid");
    }
    return body as HostedDispatchReceipt;
  }

  async execute(
    job: Parameters<AnalysisJobExecutor["execute"]>[0],
    options: Parameters<AnalysisJobExecutor["execute"]>[1],
  ): Promise<Awaited<ReturnType<AnalysisJobExecutor["execute"]>>> {
    await this.dispatch(job.id);
    while (!options.signal.aborted) {
      const attempt = await this.repository.getAttempt(this.principalSub, job.id);
      if (!attempt) {
        throw new HostedWorkflowDispatchError("hosted_attempt_not_found");
      }
      if (!isHostedAttemptTerminal(attempt)) {
        await this.sleep(200);
        continue;
      }
      if (attempt.stage === "succeeded" && attempt.runId) {
        return { runId: attempt.runId };
      }
      if (attempt.stage === "indeterminate") {
        throw new AnalysisExecutionIndeterminateError();
      }
      throw new HostedWorkflowDispatchError(
        attempt.errorCode ?? `hosted_attempt_${attempt.stage}`,
      );
    }
    throw new HostedWorkflowDispatchError("hosted_executor_aborted");
  }
}

export class HostedWorkflowDispatchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostedWorkflowDispatchError";
  }
}

export function selectAnalysisJobExecutor(input: {
  driver: "sqlite" | "d1";
  hostedEnabled: boolean;
  localExecutor?: AnalysisJobExecutor;
  hostedExecutor?: AnalysisJobExecutor;
}): AnalysisJobExecutor {
  if (input.driver === "sqlite") {
    if (!input.localExecutor) throw new Error("local_executor_unavailable");
    return input.localExecutor;
  }
  if (!input.hostedEnabled) throw new Error("hosted_executor_disabled");
  if (!input.hostedExecutor) throw new Error("hosted_executor_unavailable");
  return input.hostedExecutor;
}

export function getHostedWorkflowExecutor(event: H3Event): {
  executor: HostedWorkflowAnalysisJobExecutor;
  repository: HostedWorkflowRepository;
  principalSub: string;
  principalEmail?: string;
} {
  const config = useRuntimeConfig(event);
  const enabled = config.hostedWorkflowsEnabled === true;
  if (!enabled) {
    throw createError({ statusCode: 404, statusMessage: "Not found." });
  }
  const principal = event.context.frameOfMindPrincipal;
  if (!principal || principal.principal.startsWith("service:")) {
    throw createError({
      statusCode: 403,
      statusMessage: "A user principal is required.",
      data: { code: "user_principal_required" },
    });
  }
  const database = event.context.cloudflare?.env.DB;
  const service = event.context.cloudflare?.env.HOSTED_WORKFLOWS;
  if (!database || !service) {
    throw createError({
      statusCode: 503,
      statusMessage: "Hosted Workflow bindings are unavailable.",
    });
  }
  const repository = new HostedWorkflowRepository(database);
  return {
    executor: new HostedWorkflowAnalysisJobExecutor(
      repository,
      service,
      principal.principal,
    ),
    repository,
    principalSub: principal.principal,
    ...(principal.email ? { principalEmail: principal.email } : {}),
  };
}
