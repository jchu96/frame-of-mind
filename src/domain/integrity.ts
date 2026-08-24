import type { VersionedAnalysisRun } from "./types.js";
import {
  runImportSchema,
  versionedAnalysisRunSchema,
  versionedRunImportSchema,
  type RunImport,
  type VersionedRunImport,
} from "./schemas.js";
import { analysisOutcomeSchema } from "./analysis-outcome.js";

export function canonicalAnalysisJson(
  analysis: VersionedAnalysisRun,
): string {
  const normalized = versionedAnalysisRunSchema.parse(analysis);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export async function sha256Utf8(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function analysisDigest(
  analysis: VersionedAnalysisRun,
): Promise<string> {
  return sha256Utf8(canonicalAnalysisJson(analysis));
}

export async function validateRunImport(value: unknown): Promise<RunImport> {
  const input = runImportSchema.parse(value);
  const digest = await analysisDigest(input.analysis);
  if (digest !== input.manifest.analysisSha256.toLowerCase()) {
    throw new Error("analysis.json digest does not match manifest.json.");
  }
  return input;
}

export async function validateVersionedRunImport(
  value: unknown,
): Promise<VersionedRunImport> {
  // The optional coverage outcome is validated beside the strict durable
  // pair. It stays optional (historical bundles and projections predate it)
  // but never becomes a second analysis authority: it must match the
  // manifest's run and carries only the sanitized outcome contract.
  const { outcome: rawOutcome, ...rest } = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>;
  const input = versionedRunImportSchema.parse(rest);
  const digest = await analysisDigest(input.analysis);
  if (digest !== input.manifest.analysisSha256.toLowerCase()) {
    throw new Error("analysis.json digest does not match manifest.json.");
  }
  if (rawOutcome === undefined) return input;
  const outcome = analysisOutcomeSchema.parse(rawOutcome);
  if (outcome.runId !== input.manifest.runId) {
    throw new Error("analysis-outcome.json run ID does not match manifest.json.");
  }
  return { ...input, outcome };
}
