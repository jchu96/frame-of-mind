import { z } from "zod";
import {
  GEMINI_GENERATION_TRANSPORT_ATTEMPTS,
  GEMINI_STRUCTURED_GENERATIONS_PER_STEP,
} from "../../../src/adapters/gemini-generation-policy.js";

// Google documents approximately 300 tokens/second for video at default
// media resolution: https://ai.google.dev/gemini-api/docs/video-understanding
export const HOSTED_VIDEO_TOKEN_RATE_DEFAULT = 300;
export const HOSTED_SPEND_POLICY_VERSION = "hosted-video-v2";
export const HOSTED_PROMPT_OUTPUT_HEADROOM_PER_CALL_DEFAULT = 8_192;
export const HOSTED_MAX_INTERROGATION_CALLS_DEFAULT = 5;
export const HOSTED_PRINCIPAL_CAP_UNITS_DEFAULT = 10_000_000;

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const hostedSpendPolicyConfigSchema = z.object({
  videoTokensPerSecond: positiveSafeInteger,
  promptOutputHeadroomPerCall: positiveSafeInteger,
  maxInterrogationCalls: positiveSafeInteger.max(100),
  principalCapUnits: positiveSafeInteger,
}).strict();

export type HostedSpendPolicyConfig = z.infer<typeof hostedSpendPolicyConfigSchema>;

export const hostedSpendPlanSchema = z.object({
  version: z.literal(HOSTED_SPEND_POLICY_VERSION),
  durationSeconds: z.number().finite().positive().max(86_400),
  videoTokensPerSecond: positiveSafeInteger,
  promptOutputHeadroomPerCall: positiveSafeInteger,
  callGraph: z.object({
    transcriptionCalls: z.literal(1),
    indexCalls: z.literal(1),
    maxInterrogationCalls: positiveSafeInteger.max(100),
    structuredGenerationsPerCall: z.literal(GEMINI_STRUCTURED_GENERATIONS_PER_STEP),
    transportAttemptsPerGeneration: z.literal(GEMINI_GENERATION_TRANSPORT_ATTEMPTS),
  }).strict(),
  estimatedTokens: positiveSafeInteger,
}).strict();

export type HostedSpendPlan = z.infer<typeof hostedSpendPlanSchema>;

export const hostedProviderUsageSchema = z.object({
  promptTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  totalTokens: positiveSafeInteger,
}).strict();

export type HostedProviderUsage = z.infer<typeof hostedProviderUsageSchema>;

export interface HostedSpendEstimator {
  estimate(durationSeconds: number, config: HostedSpendPolicyConfig): HostedSpendPlan;
}

export const hostedSpendEstimator: HostedSpendEstimator = {
  estimate(durationSeconds, inputConfig) {
    const config = hostedSpendPolicyConfigSchema.parse(inputConfig);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86_400) {
      throw new HostedSpendPolicyError("spend_duration_unavailable");
    }
    const callCount = 1 + 1 + config.maxInterrogationCalls;
    const plannedGenerationAttempts = callCount
      * GEMINI_STRUCTURED_GENERATIONS_PER_STEP;
    if (
      !Number.isSafeInteger(callCount)
      || callCount < 3
      || !Number.isSafeInteger(plannedGenerationAttempts)
    ) {
      throw new HostedSpendPolicyError("spend_call_graph_unavailable");
    }
    const videoTokensPerCall = Math.ceil(
      durationSeconds * config.videoTokensPerSecond,
    );
    const estimatedTokens = plannedGenerationAttempts
      * (videoTokensPerCall + config.promptOutputHeadroomPerCall);
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1) {
      throw new HostedSpendPolicyError("spend_estimate_unavailable");
    }
    return hostedSpendPlanSchema.parse({
      version: HOSTED_SPEND_POLICY_VERSION,
      durationSeconds,
      videoTokensPerSecond: config.videoTokensPerSecond,
      promptOutputHeadroomPerCall: config.promptOutputHeadroomPerCall,
      callGraph: {
        transcriptionCalls: 1,
        indexCalls: 1,
        maxInterrogationCalls: config.maxInterrogationCalls,
        structuredGenerationsPerCall: GEMINI_STRUCTURED_GENERATIONS_PER_STEP,
        transportAttemptsPerGeneration: GEMINI_GENERATION_TRANSPORT_ATTEMPTS,
      },
      estimatedTokens,
    });
  },
};

export function hostedSpendRetryExtensionUnits(plan: HostedSpendPlan): number {
  const parsed = hostedSpendPlanSchema.parse(plan);
  const units = Math.ceil(
    parsed.durationSeconds * parsed.videoTokensPerSecond,
  ) + parsed.promptOutputHeadroomPerCall;
  if (!Number.isSafeInteger(units) || units < 1) {
    throw new HostedSpendPolicyError("spend_estimate_unavailable");
  }
  return units;
}

export function hostedSpendMaximumReservationUnits(
  plan: HostedSpendPlan,
): number {
  const parsed = hostedSpendPlanSchema.parse(plan);
  const maximum = parsed.estimatedTokens
    * parsed.callGraph.transportAttemptsPerGeneration;
  if (!Number.isSafeInteger(maximum) || maximum < parsed.estimatedTokens) {
    throw new HostedSpendPolicyError("spend_estimate_unavailable");
  }
  return maximum;
}

export class HostedSpendPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostedSpendPolicyError";
  }
}
