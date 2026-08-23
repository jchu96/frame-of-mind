export type GateTier = "pr" | "sharded";

export interface GateSelection {
  readonly tier: GateTier;
  readonly reason:
    | "requested"
    | "hosted_lane_separate"
    | "base_ref_unavailable"
    | "unsafe_path"
    | "all_paths_safe";
}

const presentationExtensions = new Set([
  ".avif", ".css", ".gif", ".ico", ".jpeg", ".jpg", ".less", ".otf",
  ".png", ".sass", ".scss", ".svg", ".ttf", ".vue", ".webp", ".woff",
  ".woff2",
]);

export function isPrSafePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.endsWith(".md")) return true;
  if (normalized.startsWith("docs/") || normalized.startsWith("conductor/")) {
    return true;
  }
  if (normalized.startsWith("test/")) return true;
  if (!normalized.startsWith("apps/web/app/")) return false;
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 && presentationExtensions.has(normalized.slice(dot).toLowerCase());
}

export function selectGateTier(
  requestedTier: GateTier,
  baseRefAvailable: boolean,
  changedPaths: readonly string[],
  hostedLaneSeparate = false,
): GateSelection {
  if (requestedTier === "sharded") return { tier: "sharded", reason: "requested" };
  if (hostedLaneSeparate) return { tier: "pr", reason: "hosted_lane_separate" };
  if (!baseRefAvailable) {
    return { tier: "sharded", reason: "base_ref_unavailable" };
  }
  if (changedPaths.some((path) => !isPrSafePath(path))) {
    return { tier: "sharded", reason: "unsafe_path" };
  }
  return { tier: "pr", reason: "all_paths_safe" };
}
