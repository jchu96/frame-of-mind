import {
  defineEventHandler,
  getRouterParam,
} from "h3";
import { throwContextHttpError } from "./http.js";
import { ContextFileStagingError } from "./local-context-staging.js";
import { getLocalContextFileStaging } from "./service.js";

export default defineEventHandler(async (event) => {
  try {
    const receipt = await (await getLocalContextFileStaging()).get(
      getRouterParam(event, "id") || "",
    );
    if (!receipt) {
      throw new ContextFileStagingError(
        "context_not_found",
        "Context file was not found or has expired.",
      );
    }
    return receipt;
  } catch (error) {
    throwContextHttpError(error);
  }
});
