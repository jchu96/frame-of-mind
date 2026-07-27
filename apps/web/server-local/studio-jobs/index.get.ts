import { defineEventHandler, getQuery } from "h3";
import { getStudioJobApi } from "./api-service.js";
import { throwJobHttpError } from "./http.js";
import { parseJobListQuery } from "./query.js";

export default defineEventHandler(async (event) => {
  try {
    return await getStudioJobApi().list(parseJobListQuery(getQuery(event)));
  } catch (error) {
    throwJobHttpError(error);
  }
});
