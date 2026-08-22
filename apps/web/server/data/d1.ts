import type { H3Event } from "h3";
import type { RunStore } from "./types";
import { createD1RunStore } from "./d1-store";

export { createD1RunStore } from "./d1-store";

export async function getRunStore(event: H3Event): Promise<RunStore> {
  const database = event.context.cloudflare?.env.DB;
  if (!database) {
    throw createError({
      statusCode: 503,
      statusMessage: "D1 binding DB is required for hosted mode.",
    });
  }
  const principal = event.context.frameOfMindPrincipal;
  if (!principal) {
    throw createError({
      statusCode: 403,
      statusMessage: "An authenticated principal is required.",
    });
  }
  return createD1RunStore(database, principal);
}
