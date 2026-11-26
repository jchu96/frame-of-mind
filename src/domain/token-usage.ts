import { z } from "zod";

const tokenCountsSchema = z.strictObject({
  promptTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  totalTokens: z.int().positive(),
});

export const tokenUsageSchema = z.partialRecord(
  z.enum(["transcript", "index", "detail", "calibration", "other"]),
  tokenCountsSchema,
);

export type TokenCounts = z.infer<typeof tokenCountsSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export function addTokenCounts(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function measuredTotal(usage?: TokenUsage): TokenCounts | undefined {
  const counts = Object.values(usage ?? {});
  if (!counts.length) return undefined;
  const total = counts.reduce(addTokenCounts);
  return Number.isSafeInteger(total.totalTokens) ? total : undefined;
}
