import type { RunImport } from "../../../src/domain/schemas";

export function runFixture(): RunImport {
  return {
    analysis: {
      schemaVersion: 1,
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
          start: "00:10",
          end: "00:20",
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
      schemaVersion: 1,
      toolVersion: "0.1.0",
      promptRevision: "test",
      runId: "20260725T120000Z-test",
      startedAt: "2026-07-25T12:00:00.000Z",
      completedAt: "2026-07-25T12:01:00.000Z",
      meetingId: "meeting-public-test",
      recipe: { id: "decisions", label: "Decisions", custom: false },
      model: "gemini-test",
      recordingSha256: "a".repeat(64),
      transcriptSha256: "b".repeat(64),
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
