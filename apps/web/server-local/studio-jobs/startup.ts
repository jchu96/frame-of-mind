import {
  clearStudioJobApi,
  configureStudioJobApi,
} from "./api-service.js";
import {
  getLocalStudioJobRuntime,
} from "./runtime.js";

export default defineNitroPlugin(async (nitroApp) => {
  const runtime = await getLocalStudioJobRuntime();
  configureStudioJobApi(runtime.api);
  nitroApp.hooks.hook("close", async () => {
    clearStudioJobApi(runtime.api);
    await runtime.shutdown();
  });
});
