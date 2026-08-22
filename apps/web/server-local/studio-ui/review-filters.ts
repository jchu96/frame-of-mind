import type {
  AnalysisItem,
  VersionedRunManifest,
} from "../../../../src/domain/types.js";
import {
  secondsToTimestamp,
  timestampToSeconds,
} from "../../../../src/lib/time.js";

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

export function reviewEvidenceTimestamp(item: AnalysisItem): string {
  return item.result.evidence?.timestamp ?? item.candidate.start;
}

export function reviewSeekSeconds(item: AnalysisItem): number {
  return timestampToSeconds(reviewEvidenceTimestamp(item));
}

export interface AlignedTranscriptExcerpt {
  text: string;
  videoTimestamp: string;
  transcriptTimestamp?: string;
  offsetSeconds?: number;
}

export function alignedTranscriptExcerpt(
  item: AnalysisItem,
  manifest: VersionedRunManifest,
): AlignedTranscriptExcerpt | undefined {
  const text = item.result.evidence?.reporterQuote;
  if (!text) return undefined;
  const videoTimestamp = reviewEvidenceTimestamp(item);
  if (manifest.schemaVersion !== 2) return { text, videoTimestamp };
  const offsetSeconds = manifest.transcriptAlignment.offsetSeconds;
  const transcriptSeconds = timestampToSeconds(videoTimestamp) + offsetSeconds;
  return {
    text,
    videoTimestamp,
    offsetSeconds,
    ...(transcriptSeconds >= 0
      ? { transcriptTimestamp: secondsToTimestamp(transcriptSeconds) }
      : {}),
  };
}
