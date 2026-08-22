import type {
  StudioMaintenanceAction,
  StudioMaintenancePlan,
} from "./plan.js";

export interface StudioMaintenanceExecutorPorts {
  deleteMedia(id: string): Promise<boolean>;
  deleteContextFile(id: string): Promise<boolean>;
  markJobStale(
    id: string,
    expectedStage: Extract<StudioMaintenanceAction, {
      action: "mark_job_stale";
    }>["expectedStage"],
    expectedUpdatedAt: string,
    occurredAt: string,
  ): Promise<boolean>;
  log?(entry: { code: string; id: string }): void;
}

export interface StudioMaintenanceSummary {
  startedAt: string;
  completedAt: string;
  planned: number;
  applied: number;
  removed: number;
  staleJobs: number;
  failures: Array<{ code: string; id: string }>;
}

function failureCode(error: unknown): string {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && /^[a-z0-9_]+$/.test(error.code)
  ) {
    return error.code;
  }
  return "maintenance_action_failed";
}

export async function executeStudioMaintenancePlan(
  plan: StudioMaintenancePlan,
  ports: StudioMaintenanceExecutorPorts,
  options: { now?: () => string } = {},
): Promise<StudioMaintenanceSummary> {
  let applied = 0;
  let removed = 0;
  let staleJobs = 0;
  const failures: Array<{ code: string; id: string }> = [];
  for (const action of plan.actions) {
    try {
      const changed = action.action === "delete_media"
        ? await ports.deleteMedia(action.id)
        : action.action === "delete_context"
          ? await ports.deleteContextFile(action.id)
          : await ports.markJobStale(
              action.id,
              action.expectedStage,
              action.expectedUpdatedAt,
              plan.generatedAt,
            );
      if (!changed) {
        ports.log?.({
          code: `maintenance_${action.action}_noop`,
          id: action.id,
        });
        continue;
      }
      applied += 1;
      if (action.action === "mark_job_stale") staleJobs += 1;
      else removed += 1;
      ports.log?.({
        code: `maintenance_${action.action}_applied`,
        id: action.id,
      });
    } catch (error) {
      const failure = { code: failureCode(error), id: action.id };
      failures.push(failure);
      ports.log?.(failure);
    }
  }
  return {
    startedAt: plan.generatedAt,
    completedAt: options.now?.() ?? plan.generatedAt,
    planned: plan.actions.length,
    applied,
    removed,
    staleJobs,
    failures,
  };
}
