import { getRunStore } from "../../utils/store";

export default defineEventHandler(async (event) => {
  const runId = getRouterParam(event, "id") || "";
  if (!/^[a-zA-Z0-9._:-]{1,240}$/.test(runId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid run ID." });
  }
  const store = await getRunStore(event);
  const run = await store.getRun(runId);
  if (!run) throw createError({ statusCode: 404, statusMessage: "Run not found." });
  return run;
});
