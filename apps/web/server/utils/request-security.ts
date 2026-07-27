import type { H3Event } from "h3";

export function trustedMutationRejection(
  fetchSite: string | undefined,
  origin: string | undefined,
  requestOrigin: string,
): { statusCode: number; statusMessage: string } | undefined {
  if (fetchSite?.toLowerCase() === "cross-site") {
    return { statusCode: 403, statusMessage: "Cross-site mutation rejected." };
  }
  if (origin && origin !== requestOrigin) {
    return { statusCode: 403, statusMessage: "Foreign-origin mutation rejected." };
  }
  return undefined;
}

export function mutationRejection(
  contentType: string | undefined,
  fetchSite: string | undefined,
  origin: string | undefined,
  requestOrigin: string,
): { statusCode: number; statusMessage: string } | undefined {
  if (!/^application\/json(?:\s*;|$)/i.test(contentType || "")) {
    return { statusCode: 415, statusMessage: "Content-Type must be application/json." };
  }
  return trustedMutationRejection(fetchSite, origin, requestOrigin);
}

export function assertTrustedMutation(event: H3Event): void {
  const rejection = trustedMutationRejection(
    getHeader(event, "sec-fetch-site"),
    getHeader(event, "origin"),
    getRequestURL(event).origin,
  );
  if (rejection) throw createError(rejection);
}

export function assertTrustedJsonMutation(event: H3Event): void {
  if (!/^application\/json(?:\s*;|$)/i.test(
    getHeader(event, "content-type") || "",
  )) {
    throw createError({
      statusCode: 415,
      statusMessage: "Content-Type must be application/json.",
    });
  }
  assertTrustedMutation(event);
}
