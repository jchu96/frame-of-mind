import { faultCode, type FaultCode } from "../domain/contract-error.js";
import type { RunFailureManifest } from "../domain/run-failure.js";

export type ProviderError = NonNullable<RunFailureManifest["error"]["provider"]> & { fault?: FaultCode };

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
  if (typeof status !== "number" || !Number.isFinite(status)) {
    const code = faultCode(error);
    if (code !== "COMMAND_FAILED") return { class: "other", fault: code };
    return isNetworkFailure(error) ? { class: "other", fault: "PROVIDER_UNREACHABLE" } : { class: "other" };
  }
  if (error instanceof ProviderStatusConflictError || hasConflictingProviderStatus(status, error)) {
    return { class: "other", status };
  }
  const classification = status === 401 || status === 403 ? "refused"
    : status === 404 ? "not_found"
    : status === 429 ? "rate_limited"
    : "other";
  const fault = error instanceof ProviderEvidenceError ? error.code : evidencedFault(error);
  return { class: classification, status, ...(fault && { fault }) };
}

export function classifyTransportFailure(error: unknown): ProviderError {
  const provider = classifyProviderError(error);
  if (provider.status === undefined && !provider.fault && error instanceof TypeError) {
    return { class: "other", fault: "PROVIDER_UNREACHABLE" };
  }
  return provider;
}

/** Direct upload responses never pass through the SDK's error-envelope reader. */
export async function classifyProviderResponse(response: Response): Promise<ProviderError> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body: unknown = await response.json();
      if (hasConflictingProviderStatus(response.status, body)) {
        return { class: "other", status: response.status };
      }
      const fault = evidencedFault(body);
      if (fault) return { ...classifyProviderError(response), fault };
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

export class ProviderEvidenceError extends Error {
  constructor(readonly status: number, readonly code: FaultCode) { super("Gemini refused the request."); }
}

export function evidencedFault(body: unknown): FaultCode | undefined {
  const details = (body as {error?: {details?: unknown}} | null)?.error?.details;
  if (!Array.isArray(details)) return;
  for (const detail of details) {
    if (detail?.["@type"] !== "type.googleapis.com/google.rpc.ErrorInfo") continue;
    switch (detail.reason) {
      case "API_KEY_INVALID": case "API_KEY_EXPIRED": return "KEY_REFUSED";
      case "UPLOAD_OTHER_KEY": return "UPLOAD_OTHER_KEY";
      case "UPLOAD_EXPIRED": return "UPLOAD_EXPIRED";
    }
  }
}

function isNetworkFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const { code, name, cause } = error as NodeJS.ErrnoException;
    if (name === "TimeoutError" || ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
      "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"].includes(code ?? "")) return true;
    error = cause;
  }
  return false;
}

export function providerFault(provider: ProviderError): FaultCode {
  if (provider.fault) return provider.fault;
  if (provider.class === "rate_limited") return "RATE_LIMITED";
  return provider.status !== undefined ? "PROVIDER_REFUSED" : "COMMAND_FAILED";
}

export function providerFailureCode(error: unknown): FaultCode {
  const code = faultCode(error);
  return code === "COMMAND_FAILED" ? providerFault(classifyProviderError(error)) : code;
}
