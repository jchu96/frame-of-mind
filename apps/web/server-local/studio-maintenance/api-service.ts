import type {
  StudioMaintenanceController,
  StudioMaintenanceDiagnostics,
} from "./controller.js";

export class StudioMaintenanceApiUnavailableError extends Error {
  constructor() {
    super("Local Studio maintenance diagnostics are unavailable.");
    this.name = "StudioMaintenanceApiUnavailableError";
  }
}

let configuredMaintenance: StudioMaintenanceController | undefined;

export function configureStudioMaintenanceApi(
  maintenance: StudioMaintenanceController,
): void {
  if (configuredMaintenance && configuredMaintenance !== maintenance) {
    throw new Error("Local Studio maintenance API is already configured.");
  }
  configuredMaintenance = maintenance;
}

export function clearStudioMaintenanceApi(
  maintenance: StudioMaintenanceController,
): void {
  if (configuredMaintenance === maintenance) configuredMaintenance = undefined;
}

export function getStudioMaintenanceDiagnostics():
Promise<StudioMaintenanceDiagnostics> {
  if (!configuredMaintenance) throw new StudioMaintenanceApiUnavailableError();
  return configuredMaintenance.diagnostics();
}
