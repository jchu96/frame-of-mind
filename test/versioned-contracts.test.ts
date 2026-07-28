import { describe, expect, it } from "vitest";
import type {
  AnalysisRunV3,
  RunManifestV3,
} from "../src/domain/types.js";
import {
  analysisRunSchema,
  runImportSchema,
  versionedRunImportSchema,
} from "../src/domain/schemas.js";
import {
  analysisDigest,
  validateVersionedRunImport,
} from "../src/domain/integrity.js";

describe("versioned run contracts", () => {
  it("preserves the v2 import contract", () => {
    const pair = v2Pair();
    expect(runImportSchema.parse(pair).analysis.schemaVersion).toBe(2);
    expect(versionedRunImportSchema.parse(pair).analysis.schemaVersion).toBe(2);
  });

  it("accepts an honestly video-only v3 pair", async () => {
    const pair = await videoOnlyPair();
    const parsed = versionedRunImportSchema.parse(pair);

    expect(parsed.analysis).toMatchObject({
      schemaVersion: 3,
      context: { mode: "none" },
    });
    expect(parsed.manifest).toMatchObject({
      schemaVersion: 3,
      context: { mode: "none" },
      mediaSource: "local-file",
    });
    expect(parsed.manifest).not.toHaveProperty("meetingId");
    expect(parsed.manifest).not.toHaveProperty("transcriptSha256");
    expect(parsed.manifest).not.toHaveProperty("transcriptAlignment");
    await expect(validateVersionedRunImport(pair)).resolves.toEqual(parsed);
  });

  it("rejects fabricated meeting provenance on video-only v3 pairs", async () => {
    const pair = await videoOnlyPair();
    const fabricated = {
      ...pair,
      manifest: {
        ...pair.manifest,
        meetingId: "fake-meeting",
        transcriptSha256: "0".repeat(64),
      },
    };

    expect(versionedRunImportSchema.safeParse(fabricated).success).toBe(false);
  });

  it("rejects a video-only pair that claims remote meeting media", async () => {
    const pair = await videoOnlyPair();
    const impossible = {
      ...pair,
      manifest: { ...pair.manifest, mediaSource: "bluedot-mcp" },
    };

    expect(versionedRunImportSchema.safeParse(impossible).success).toBe(false);
  });

  it("keeps v2-only consumers fail-closed on v3", async () => {
    const pair = await videoOnlyPair();
    expect(runImportSchema.safeParse(pair).success).toBe(false);
    expect(analysisRunSchema.safeParse(pair.analysis).success).toBe(false);
  });

  it("rejects a video-only pair whose analysis digest was changed", async () => {
    const pair = await videoOnlyPair();
    pair.analysis.matchNotes = "Mutated after the manifest was created.";

    await expect(validateVersionedRunImport(pair)).rejects.toThrow(
      "analysis.json digest does not match manifest.json.",
    );
  });
});

async function videoOnlyPair(): Promise<{
  analysis: AnalysisRunV3;
  manifest: RunManifestV3;
}> {
  const analysis: AnalysisRunV3 = {
    schemaVersion: 3,
    runId: "video-only-test",
    recipe: { id: "issue-review", label: "Issue review" },
    context: { mode: "none" },
    model: "gemini-test",
    matchNotes: "Indexed from recording evidence only.",
    items: [],
  };
  return {
    analysis,
    manifest: {
      schemaVersion: 3,
      toolVersion: "0.2.1",
      promptRevision: "2026-07-28.1",
      runId: analysis.runId,
      startedAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:01:00.000Z",
      context: { mode: "none" },
      recipe: {
        id: analysis.recipe.id,
        label: analysis.recipe.label,
        custom: false,
        revision: "test",
        sha256: "a".repeat(64),
      },
      model: analysis.model,
      recordingSha256: "b".repeat(64),
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

function v2Pair() {
  return {
    analysis: {
      schemaVersion: 2,
      runId: "meeting-test",
      recipe: { id: "issue-review", label: "Issue review" },
      meeting: { id: "meeting-1", provider: "file" },
      model: "gemini-test",
      matchNotes: "Matched.",
      items: [],
    },
    manifest: {
      schemaVersion: 2,
      toolVersion: "0.2.1",
      promptRevision: "2026-07-27.2",
      runId: "meeting-test",
      startedAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:01:00.000Z",
      meetingId: "meeting-1",
      recipe: {
        id: "issue-review",
        label: "Issue review",
        custom: false,
        revision: "test",
        sha256: "a".repeat(64),
      },
      model: "gemini-test",
      recordingSha256: "b".repeat(64),
      transcriptSha256: "c".repeat(64),
      analysisSha256: "d".repeat(64),
      recordingMimeType: "video/mp4",
      contextProvider: "file",
      contextTransport: "file",
      mediaSource: "local-file",
      transcriptAlignment: {
        offsetSeconds: 0,
        method: "none",
        confidence: "none",
      },
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
