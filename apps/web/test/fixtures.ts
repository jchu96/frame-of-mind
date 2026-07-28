import type {
  RunImport,
  RunImportV3,
} from "../../../src/domain/schemas";
import { analysisDigest } from "../../../src/domain/integrity";

export function runFixture(): RunImport {
  return {
    analysis: {
      schemaVersion: 2,
      runId: "20260725T120000Z-test",
      recipe: { id: "decisions", label: "Decisions" },
      meeting: {
        id: "meeting-public-test",
        provider: "file",
        title: "Product review",
      },
      model: "gemini-test",
      matchNotes: "The recording and context match.",
      items: [{
        candidate: {
          start: "00:00:10",
          end: "00:00:20",
          summary: "A decision was made.",
          kind: "decision",
          importance: "high",
        },
        result: {
          accepted: true,
          kind: "decision",
          title: "Use the portable contract",
          summary: "The database remains a projection.",
          importance: "high",
        },
      }],
    },
    manifest: {
      schemaVersion: 2,
  toolVersion: "0.2.1",
      promptRevision: "test",
      runId: "20260725T120000Z-test",
      startedAt: "2026-07-25T12:00:00.000Z",
      completedAt: "2026-07-25T12:01:00.000Z",
      meetingId: "meeting-public-test",
      recipe: {
        id: "decisions",
        label: "Decisions",
        custom: false,
        revision: "test",
        sha256: "c".repeat(64),
      },
      model: "gemini-test",
      recordingSha256: "a".repeat(64),
      transcriptSha256: "b".repeat(64),
      analysisSha256: "b76101b1b32eb17f78a2bf0ecd280608151b36e0bf9e440634ddd7f26d799195",
      recordingMimeType: "video/mp4",
      contextProvider: "file",
      contextTransport: "file",
      mediaSource: "local-file",
      transcriptAlignment: {
        offsetSeconds: 0,
        method: "none",
        confidence: "none",
      },
      remoteFile: { deleted: true },
      analysis: {
        maxIncidents: 3,
        indexFps: 0.5,
        indexResolution: "low",
        interrogationResolution: "medium",
      },
      artifacts: ["analysis.json", "manifest.json"],
    },
  };
}

export async function videoRunFixture(): Promise<RunImportV3> {
  const analysis: RunImportV3["analysis"] = {
    schemaVersion: 3,
    runId: "20260728T120000Z-video-test",
    recipe: { id: "issue-review", label: "Issue review" },
    context: { mode: "none" },
    model: "gemini-test",
    matchNotes: "Indexed from recording evidence only.",
    items: [{
      candidate: {
        start: "00:00:10",
        end: "00:00:20",
        summary: "A visible issue was demonstrated.",
        kind: "issue",
        importance: "high",
      },
      result: {
        accepted: true,
        kind: "issue",
        title: "Fix the visible issue",
        summary: "The recording directly shows the failure.",
        importance: "high",
      },
    }],
  };
  return {
    analysis,
    manifest: {
      schemaVersion: 3,
      toolVersion: "0.2.1",
      promptRevision: "2026-07-28.1",
      runId: analysis.runId,
      startedAt: "2026-07-28T12:00:00.000Z",
      completedAt: "2026-07-28T12:01:00.000Z",
      context: { mode: "none" },
      recipe: {
        id: analysis.recipe.id,
        label: analysis.recipe.label,
        custom: false,
        revision: "test",
        sha256: "c".repeat(64),
      },
      model: analysis.model,
      recordingSha256: "a".repeat(64),
      analysisSha256: await analysisDigest(analysis),
      recordingMimeType: "video/mp4",
      mediaSource: "local-file",
      remoteFile: { deleted: true },
      analysis: {
        maxIncidents: 3,
        indexFps: 0.5,
        indexResolution: "low",
        interrogationResolution: "medium",
      },
      artifacts: ["analysis.json", "manifest.json"],
    },
  };
}
