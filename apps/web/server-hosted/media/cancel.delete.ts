import { defineEventHandler, getRouterParam } from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import {
  getHostedMediaRuntime,
  throwHostedMediaHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const runtime = getHostedMediaRuntime(event);
    await runtime.service.cancel(
      runtime.principalSub,
      parseOpaqueResourceId(getRouterParam(event, "id")),
    );
    return { ok: true, state: "abandoned" };
  } catch (error) {
    throwHostedMediaHttpError(error);
  }
});
