import { getRunStore } from "../../utils/store";
import { runIdSchema } from "../../../../../src/domain/schemas";

export default defineEventHandler(async (event) => {
  const runId = getRouterParam(event, "id") || "";
  if (!runIdSchema.safeParse(runId).success) {
    throw createError({ statusCode: 400, statusMessage: "Invalid run ID." });
  }
  const store = await getRunStore(event);
  const run = await store.getRun(runId);
  if (!run) throw createError({ statusCode: 404, statusMessage: "Run not found." });
  return run;
});
