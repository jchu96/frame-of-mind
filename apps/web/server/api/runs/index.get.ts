import { getRunStore } from "../../utils/store";
import { decodeRunCursor } from "../../data/types";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const requested = Number(query.limit || 50);
  const limit = Number.isInteger(requested) && requested >= 1 && requested <= 100 ? requested : 50;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  if (cursor && !decodeRunCursor(cursor)) {
    throw createError({ statusCode: 400, statusMessage: "Run cursor is invalid." });
  }
  const store = await getRunStore(event);
  return store.listRuns({
    limit,
    ...(cursor ? { cursor } : {}),
  });
});
