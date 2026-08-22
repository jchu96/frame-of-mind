export const DEFAULT_STUDIO_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1_000;
export const DEFAULT_STALE_JOB_HORIZON_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;

export interface StudioMaintenanceConfiguration {
  intervalMs: number;
  orphanGraceMs: number;
  scheduled: boolean;
  staleJobHorizonMs: number;
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: { allowZero?: boolean } = {},
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value)
    || value < (options.allowZero ? 0 : 1)
  ) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function maintenanceConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): StudioMaintenanceConfiguration {
  const intervalMs = positiveInteger(
    environment,
    "FRAME_OF_MIND_MAINTENANCE_INTERVAL_MS",
    DEFAULT_STUDIO_MAINTENANCE_INTERVAL_MS,
    { allowZero: true },
  );
  return {
    intervalMs,
    orphanGraceMs: positiveInteger(
      environment,
      "FRAME_OF_MIND_MAINTENANCE_ORPHAN_GRACE_MS",
      DEFAULT_ORPHAN_GRACE_MS,
    ),
    scheduled: intervalMs > 0,
    staleJobHorizonMs: positiveInteger(
      environment,
      "FRAME_OF_MIND_MAINTENANCE_STALE_JOB_MS",
      DEFAULT_STALE_JOB_HORIZON_MS,
    ),
  };
}
