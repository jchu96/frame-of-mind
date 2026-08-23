import { createError, type H3Event } from "h3";
import { z } from "zod";
import type { HostedD1Database } from "../../../workflows/src/repository.js";
import { getHostedMediaPrincipal } from "../media/http.js";
import type { HostedR2Bucket } from "../media/retention.js";
import { HostedEvidenceError, HostedEvidenceService } from "./service.js";

export function getHostedEvidenceRuntime(event: H3Event): {
  principalSub: string;
  service: HostedEvidenceService;
} {
  const principalSub = getHostedMediaPrincipal(event);
  const environment = event.context.cloudflare?.env as Record<string, unknown> | undefined;
  if (!environment?.DB || !environment.RETAINED_MEDIA) {
    throw createError({
      statusCode: 503,
      statusMessage: "Hosted evidence bindings are unavailable.",
      data: { code: "hosted_evidence_bindings_unavailable" },
    });
  }
  return {
    principalSub,
    service: new HostedEvidenceService(
      environment.DB as HostedD1Database,
      environment.RETAINED_MEDIA as HostedR2Bucket,
    ),
  };
}

export function throwHostedEvidenceHttpError(error: unknown): never {
  if (error instanceof z.ZodError) {
    throw createError({
      statusCode: 422,
      statusMessage: "Hosted evidence provenance is invalid.",
      data: { code: "hosted_capture_provenance_invalid" },
    });
  }
  if (error instanceof HostedEvidenceError) {
    const statusCode = error.code === "hosted_capture_run_not_found"
      || error.code === "hosted_capture_media_unavailable"
      ? 404
      : 422;
    throw createError({
      statusCode,
      statusMessage: statusCode === 404
        ? "Hosted evidence source was not found."
        : "Hosted evidence capture was refused.",
      data: { code: error.code },
    });
  }
  if (error && typeof error === "object" && "statusCode" in error) throw error;
  throw createError({ statusCode: 500, statusMessage: "Hosted evidence request failed." });
}
