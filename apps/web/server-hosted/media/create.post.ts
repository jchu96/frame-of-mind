import { defineEventHandler, setResponseStatus } from "h3";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { hostedMediaCreateRequestSchema } from "../../../workflows/src/media.js";
import {
  getHostedMediaRuntime,
  readHostedMediaJson,
  throwHostedMediaHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const runtime = getHostedMediaRuntime(event);
    const request = hostedMediaCreateRequestSchema.parse(
      await readHostedMediaJson(event),
    );
    const response = await runtime.service.create(runtime.principalSub, request);
    setResponseStatus(event, 201);
    return response;
  } catch (error) {
    throwHostedMediaHttpError(error);
  }
});
