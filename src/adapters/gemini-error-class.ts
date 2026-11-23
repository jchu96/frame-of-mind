import type { RunFailureManifest } from "../domain/run-failure.js";

export type ProviderError = NonNullable<RunFailureManifest["error"]["provider"]>;

// Canonical google.rpc.Code HTTP mappings, not message/prose matching.
const canonicalStatuses: Readonly<Record<string, number>> = {
  OK: 200, INVALID_ARGUMENT: 400, FAILED_PRECONDITION: 400, OUT_OF_RANGE: 400,
  UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, NOT_FOUND: 404,
  ALREADY_EXISTS: 409, ABORTED: 409, RESOURCE_EXHAUSTED: 429, CANCELLED: 499,
  UNKNOWN: 500, INTERNAL: 500, UNIMPLEMENTED: 501, UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

export function hasConflictingProviderStatus(status: number, body: unknown): boolean {
  if (!body || typeof body !== "object" || !("error" in body)) return false;
  const detail = body.error;
  if (!detail || typeof detail !== "object") return false;
  return ("code" in detail && detail.code !== undefined && detail.code !== status)
    || ("status" in detail && detail.status !== undefined
      && (typeof detail.status !== "string"
        || !Object.hasOwn(canonicalStatuses, detail.status)
        || canonicalStatuses[detail.status] !== status));
}

/** Carries no body, message, URL or cause from the provider. Status still drives retries. */
export class ProviderStatusConflictError extends Error {
  constructor(readonly status: number) {
    super("Gemini returned conflicting structured error statuses.");
  }
}

/** Numeric HTTP status is authoritative only when structured evidence agrees. */
export function classifyProviderError(error: unknown): ProviderError {
  const status = error && typeof error === "object" && "status" in error
    ? error.status
    : undefined;
  if (typeof status !== "number" || !Number.isFinite(status)) return { class: "other" };
  if (error instanceof ProviderStatusConflictError || hasConflictingProviderStatus(status, error)) {
    return { class: "other", status };
  }
  const classification = status === 401 || status === 403 ? "refused"
    : status === 404 ? "not_found"
    : status === 429 ? "rate_limited"
    : "other";
  return { class: classification, status };
}

/** Direct upload responses never pass through the SDK's error-envelope reader. */
export async function classifyProviderResponse(response: Response): Promise<ProviderError> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body: unknown = await response.json();
      if (hasConflictingProviderStatus(response.status, body)) {
        return { class: "other", status: response.status };
      }
    } catch {
      // Unreadable structured evidence cannot support a confident class.
      return { class: "other", status: response.status };
    }
  }
  return classifyProviderError(response);
}

export function providerErrorDescription(provider: ProviderError): string {
  const labels = {
    refused: "the provider refused the request",
    not_found: "not_found (not found)",
    rate_limited: "rate_limited (rate limited)",
    other: "other provider error",
  };
  return labels[provider.class] + (provider.status === undefined ? "" : ` (HTTP ${provider.status})`);
}
