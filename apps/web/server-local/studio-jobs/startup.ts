import {
  clearStudioJobApi,
  configureStudioJobApi,
} from "./api-service.js";
import {
  getLocalStudioJobRuntime,
} from "./runtime.js";
import {
  clearStudioMaintenanceApi,
  configureStudioMaintenanceApi,
} from "../studio-maintenance/api-service.js";
import {
  clearStudioReviewMedia,
  configureStudioReviewMedia,
} from "../studio-media/review-service.js";

export default defineNitroPlugin(async (nitroApp) => {
  const runtime = await getLocalStudioJobRuntime();
  configureStudioJobApi(runtime.api);
  configureStudioMaintenanceApi(runtime.maintenance);
  configureStudioReviewMedia(runtime.reviewMedia);
  nitroApp.hooks.hook("close", async () => {
    clearStudioReviewMedia(runtime.reviewMedia);
    clearStudioMaintenanceApi(runtime.maintenance);
    clearStudioJobApi(runtime.api);
    await runtime.shutdown();
  });
});
