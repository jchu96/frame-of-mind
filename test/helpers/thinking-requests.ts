import { ApiError, type GenerateContentParameters } from "@google/genai";
import type { GeminiVideoAnalyzer } from "../../src/adapters/gemini.js";

// Synthetic inputs shared with the base-commit request capture.
const file = { name: "files/thinking-test", uri: "https://generativelanguage.googleapis.com/v1beta/files/thinking-test", mimeType: "video/mp4" };
const recipe = { id: "test", label: "Test", description: "Synthetic test", indexInstruction: "Find changes.", interrogationInstruction: "Describe changes." };
const candidate = { start: "00:00:01", end: "00:00:02", summary: "Synthetic change", kind: "test", importance: "low" as const };
const responses = [
  { matchNotes: "Synthetic", moments: [candidate] },
  { isRelevantCall: true, matchNotes: "Synthetic", transcriptAlignment: { offsetSeconds: 0, confidence: "high", rationale: "Aligned" }, moments: [candidate] },
  { accepted: true, kind: "test", title: "Synthetic", summary: "Synthetic change", evidence: { timestamp: "00:00:01" } },
  { segments: [{ start: "00:00:01", end: "00:00:02", speaker: "Speaker 1", text: "Synthetic speech" }] },
  { seconds: 27 },
];

export function refuseBudgetWithLevel(parameters: GenerateContentParameters): void {
  // Documented status; message is deliberately synthetic, not parsed by the tool.
  // https://aistudio.google.com/docs/thinking?generate-content=true
  const config = parameters.config?.thinkingConfig;
  if (config?.thinkingLevel !== undefined && config.thinkingBudget !== undefined) {
    throw new ApiError({ status: 400, message: "Synthetic incompatible thinking settings" });
  }
}

export async function captureThinkingRequests(Analyzer: typeof GeminiVideoAnalyzer, level?: string) {
  const requests: GenerateContentParameters[] = [];
  const analyzer = new Analyzer("synthetic-key", "gemini-test", {
    generateContent: async parameters => {
      refuseBudgetWithLevel(parameters);
      requests.push(parameters);
      return { text: JSON.stringify(responses[requests.length - 1]), usageMetadata: { promptTokenCount: 7, totalTokenCount: 11 } };
    },
  }, level);
  await analyzer.index(file, undefined, recipe);
  await analyzer.index(file, { id: "synthetic", provider: "file", transport: "file", transcript: "[00:00:01] Speaker 1: Synthetic speech", raw: {} }, recipe);
  await analyzer.interrogate(file, candidate, undefined, recipe);
  await analyzer.transcribe({ ...file, mimeType: "audio/aac" });
  await analyzer.probeClipClock(file);
  return { requests, analyzer };
}
