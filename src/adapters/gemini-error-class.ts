import type { RunFailureManifest } from "../domain/run-failure.js";

export type ProviderError = NonNullable<RunFailureManifest["error"]["provider"]>;

/** Only the numeric HTTP status crosses the provider error boundary. */
export function classifyProviderError(error: unknown): ProviderError {
  const status = error && typeof error === "object" && "status" in error
    ? error.status
    : undefined;
  if (typeof status !== "number" || !Number.isFinite(status)) return { class: "other" };
  const classification = status === 401 || status === 403 ? "refused"
    : status === 404 ? "not_found"
    : status === 429 ? "rate_limited"
    : "other";
  return { class: classification, status };
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
