import type { VersionedAnalysisRun } from "./types.js";
import {
  runImportSchema,
  versionedAnalysisRunSchema,
  versionedRunImportSchema,
  type RunImport,
  type VersionedRunImport,
} from "./schemas.js";

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
  const input = versionedRunImportSchema.parse(value);
  const digest = await analysisDigest(input.analysis);
  if (digest !== input.manifest.analysisSha256.toLowerCase()) {
    throw new Error("analysis.json digest does not match manifest.json.");
  }
  return input;
}
