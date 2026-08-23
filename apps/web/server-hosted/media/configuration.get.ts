import { defineEventHandler, setResponseHeader } from "h3";
import {
  getHostedMediaPrincipal,
  throwHostedMediaHttpError,
} from "./http.js";

export default defineEventHandler((event) => {
  try {
    getHostedMediaPrincipal(event);
    setResponseHeader(event, "cache-control", "no-store");
    return { available: true };
  } catch (error) {
    throwHostedMediaHttpError(error);
  }
});
