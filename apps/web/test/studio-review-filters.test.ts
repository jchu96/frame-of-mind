import { describe, expect, test } from "bun:test";
import type { AnalysisItem } from "../../../src/domain/types";
import {
  alignedTranscriptExcerpt,
  filterReviewFindings,
  reviewEvidenceTimestamp,
  reviewMarkerPosition,
  reviewSeekSeconds,
  reviewTimelineSeconds,
} from "../server-local/studio-ui/review-filters";
import { runFixture } from "./fixtures";

function finding(
  title: string,
  accepted: boolean,
  start: string,
  end: string,
): AnalysisItem {
  return {
    candidate: {
      start,
      end,
      summary: `${title} candidate`,
      kind: "synthetic",
      importance: "medium",
    },
    result: {
      accepted,
      kind: "synthetic",
      title,
      summary: `${title} summary`,
    },
  };
}

const findings = [
  finding("Accepted one", true, "00:00:10", "00:00:20"),
  finding("Rejected one", false, "00:00:30", "00:00:40"),
  finding("Accepted two", true, "00:01:00", "00:01:10"),
];

describe("Studio review finding filters", () => {
  test("keeps stable source indexes across all dispositions", () => {
    expect(filterReviewFindings(findings, "all").map((entry) => entry.index))
      .toEqual([0, 1, 2]);
    expect(filterReviewFindings(findings, "accepted").map((entry) => entry.index))
      .toEqual([0, 2]);
    expect(filterReviewFindings(findings, "rejected").map((entry) => entry.index))
      .toEqual([1]);
  });

  test("derives bounded candidate marker positions", () => {
    expect(reviewTimelineSeconds(findings)).toBe(70);
    expect(reviewMarkerPosition(findings[0]!, 100)).toBe(10);
    expect(reviewMarkerPosition(findings[2]!, 30)).toBe(100);
  });

  test("maps canonical evidence time to player and aligned transcript time", () => {
    const item = finding("Aligned", true, "00:00:10", "00:00:20");
    item.result.evidence = {
      timestamp: "00:00:12",
      reporterQuote: "Synthetic transcript excerpt.",
    };
    const manifest = runFixture().manifest;
    manifest.transcriptAlignment = {
      offsetSeconds: 3_767,
      method: "explicit",
      confidence: "high",
    };

    expect(reviewEvidenceTimestamp(item)).toBe("00:00:12");
    expect(reviewSeekSeconds(item)).toBe(12);
    expect(alignedTranscriptExcerpt(item, manifest)).toEqual({
      text: "Synthetic transcript excerpt.",
      videoTimestamp: "00:00:12",
      transcriptTimestamp: "01:02:59",
      offsetSeconds: 3_767,
    });
  });

  test("does not invent a transcript timestamp before transcript time zero", () => {
    const item = finding("Before transcript", true, "00:00:10", "00:00:20");
    item.result.evidence = { reporterQuote: "Later transcript start." };
    const manifest = runFixture().manifest;
    manifest.transcriptAlignment = {
      offsetSeconds: -20,
      method: "explicit",
      confidence: "high",
    };
    expect(alignedTranscriptExcerpt(item, manifest)).toEqual({
      text: "Later transcript start.",
      videoTimestamp: "00:00:10",
      offsetSeconds: -20,
    });
  });
});
