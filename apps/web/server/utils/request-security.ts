import type { H3Event } from "h3";

export function mutationRejection(
  contentType: string | undefined,
  fetchSite: string | undefined,
  origin: string | undefined,
  requestOrigin: string,
): { statusCode: number; statusMessage: string } | undefined {
  if (!/^application\/json(?:\s*;|$)/i.test(contentType || "")) {
    return { statusCode: 415, statusMessage: "Content-Type must be application/json." };
  }
  if (fetchSite?.toLowerCase() === "cross-site") {
    return { statusCode: 403, statusMessage: "Cross-site mutation rejected." };
  }
  if (origin && origin !== requestOrigin) {
    return { statusCode: 403, statusMessage: "Foreign-origin mutation rejected." };
  }
  return undefined;
}

export function assertTrustedJsonMutation(event: H3Event): void {
  const rejection = mutationRejection(
    getHeader(event, "content-type"),
    getHeader(event, "sec-fetch-site"),
    getHeader(event, "origin"),
    getRequestURL(event).origin,
  );
  if (rejection) throw createError(rejection);
}
