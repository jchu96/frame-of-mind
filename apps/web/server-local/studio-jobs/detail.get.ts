import {
  createError,
  defineEventHandler,
  getQuery,
  getRouterParam,
} from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { getStudioJobApi } from "./api-service.js";
import { throwJobHttpError } from "./http.js";
import { parseJobEventQuery } from "./query.js";

export default defineEventHandler(async (event) => {
  try {
    const id = parseOpaqueResourceId(getRouterParam(event, "id"));
    const detail = await getStudioJobApi().detail(
      id,
      parseJobEventQuery(getQuery(event)),
    );
    if (!detail) {
      throw createError({
        statusCode: 404,
        statusMessage: "Analysis job was not found.",
      });
    }
    return detail;
  } catch (error) {
    throwJobHttpError(error);
  }
});
