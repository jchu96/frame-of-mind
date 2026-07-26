import type { AnalysisRun } from "./types.js";
import {
  analysisRunSchema,
  runImportSchema,
  type RunImport,
} from "./schemas.js";

export function canonicalAnalysisJson(analysis: AnalysisRun): string {
  const normalized = analysisRunSchema.parse(analysis);
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

export async function analysisDigest(analysis: AnalysisRun): Promise<string> {
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
