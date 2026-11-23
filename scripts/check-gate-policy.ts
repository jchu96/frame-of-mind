export type GateTier = "pr" | "sharded";

export function selectGateTier(requestedTier: GateTier): {
  readonly tier: GateTier;
  readonly reason: "requested" | "hosted_nightly_and_deploy";
} {
  return {
    tier: requestedTier,
    reason: requestedTier === "pr" ? "hosted_nightly_and_deploy" : "requested",
  };
}
