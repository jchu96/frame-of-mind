import {
  createError,
  defineEventHandler,
  getQuery,
  getRouterParam,
} from "h3";
import { z } from "zod";
import { getStudioMeetingCatalogService, StudioMeetingCatalogError } from "./service.js";

const querySchema = z.object({
  transport: z.enum(["mcp", "api"]),
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(16).default(8),
}).strict();

export default defineEventHandler(async (event) => {
  const provider = z.enum(["bluedot", "granola"]).safeParse(
    getRouterParam(event, "provider"),
  );
  const query = querySchema.safeParse(getQuery(event));
  if (!provider.success || !query.success) {
    throw createError({
      statusCode: 400,
      statusMessage: "Meeting catalog query is invalid.",
    });
  }
  try {
    return await getStudioMeetingCatalogService().search({
      provider: provider.data,
      ...query.data,
    });
  } catch (error) {
    if (error instanceof StudioMeetingCatalogError) {
      throw createError({
        statusCode: error.code === "catalog_unavailable" ? 501 : 502,
        statusMessage: error.code === "catalog_unavailable"
          ? "This provider transport does not expose a meeting catalog."
          : "Meeting catalog could not be loaded. Reconnect the provider and retry.",
      });
    }
    throw createError({
      statusCode: 500,
      statusMessage: "Meeting catalog request failed.",
    });
  }
});
