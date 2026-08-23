import { defineEventHandler } from "h3";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import {
  getHostedMediaRuntime,
  throwHostedMediaHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const runtime = getHostedMediaRuntime(event);
    const swept = await runtime.service.sweep(runtime.principalSub);
    return { ok: true, ...swept };
  } catch (error) {
    throwHostedMediaHttpError(error);
  }
});
