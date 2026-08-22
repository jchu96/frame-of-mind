import { createError, defineEventHandler, setHeader } from "h3";
import {
  getStudioMaintenanceDiagnostics,
  StudioMaintenanceApiUnavailableError,
} from "./api-service.js";

export default defineEventHandler(async (event) => {
  setHeader(event, "cache-control", "no-store");
  try {
    return await getStudioMaintenanceDiagnostics();
  } catch (error) {
    if (error instanceof StudioMaintenanceApiUnavailableError) {
      throw createError({
        statusCode: 503,
        statusMessage: error.message,
      });
    }
    throw createError({
      statusCode: 500,
      statusMessage: "Local Studio maintenance diagnostics failed.",
    });
  }
});
