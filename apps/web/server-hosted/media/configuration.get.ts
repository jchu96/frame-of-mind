import { defineEventHandler, setResponseHeader } from "h3";
import {
  getHostedMediaPrincipal,
  hostedMediaPolicy,
  throwHostedMediaHttpError,
} from "./http.js";

export default defineEventHandler((event) => {
  try {
    getHostedMediaPrincipal(event);
    setResponseHeader(event, "cache-control", "no-store");
    const policy = hostedMediaPolicy(event);
    return {
      available: true,
      maxBytes: policy.maxBytes,
      sessionTtlSeconds: policy.sessionTtlSeconds,
    };
  } catch (error) {
    throwHostedMediaHttpError(error);
  }
});
