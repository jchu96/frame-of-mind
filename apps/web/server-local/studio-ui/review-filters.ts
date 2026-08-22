import type { AnalysisItem } from "../../../../src/domain/types.js";
import { timestampToSeconds } from "../../../../src/lib/time.js";

export type ReviewFindingFilter = "all" | "accepted" | "rejected";

export interface ReviewFindingEntry {
  index: number;
  item: AnalysisItem;
}

export function filterReviewFindings(
  items: readonly AnalysisItem[],
  filter: ReviewFindingFilter,
): ReviewFindingEntry[] {
  return items.flatMap((item, index) => {
    if (
      filter === "accepted" && !item.result.accepted
      || filter === "rejected" && item.result.accepted
    ) {
      return [];
    }
    return [{ index, item }];
  });
}

export function reviewTimelineSeconds(items: readonly AnalysisItem[]): number {
  return Math.max(
    1,
    ...items.map((item) => timestampToSeconds(item.candidate.end)),
  );
}

export function reviewMarkerPosition(
  item: AnalysisItem,
  durationSeconds: number,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, timestampToSeconds(item.candidate.start) / durationSeconds * 100),
  );
}
