import { defineEventHandler, getRouterParam } from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { hostedMediaView } from "../../../workflows/src/contracts.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import {
  getHostedMediaRuntime,
  throwHostedMediaHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const runtime = getHostedMediaRuntime(event);
    const receipt = await runtime.service.seal(
      runtime.principalSub,
      parseOpaqueResourceId(getRouterParam(event, "id")),
    );
    return { media: hostedMediaView(receipt) };
  } catch (error) {
    throwHostedMediaHttpError(error);
  }
});
