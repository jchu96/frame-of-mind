import { describe, expect, test } from "bun:test";
import {
  runImportSchema,
  versionedRunImportSchema,
} from "../../../src/domain/schemas";
import {
  analysisDigest,
  validateRunImport,
  validateVersionedRunImport,
} from "../../../src/domain/integrity";
import type { AnalysisRun } from "../../../src/domain/types";
import { runFixture, videoRunFixture } from "./fixtures";

describe("run import contract", () => {
  test("accepts a matching analysis and manifest", () => {
    expect(runImportSchema.parse(runFixture()).manifest.runId).toContain("test");
  });

  test("accepts an explicit video-only v3 pair through the web boundary", async () => {
    const input = await videoRunFixture();
    expect(versionedRunImportSchema.parse(input).analysis.schemaVersion).toBe(3);
    await expect(validateVersionedRunImport(input)).resolves.toEqual(input);
    expect(runImportSchema.safeParse(input).success).toBe(false);
  });

  test("binds analysis to the manifest run ID and digest", async () => {
    const mismatched = runFixture();
    mismatched.analysis.runId = "different-run";
    expect(runImportSchema.safeParse(mismatched).success).toBe(false);

    const tampered = runFixture();
    tampered.analysis.matchNotes = "Tampered after manifest creation.";
    expect(validateRunImport(tampered)).rejects.toThrow(/digest/);
  });

  test("canonicalizes equivalent analysis objects before hashing", async () => {
    const input = runFixture();
    const reordered = Object.fromEntries(
      Object.entries(input.analysis).reverse(),
    ) as unknown as AnalysisRun;
    expect(await analysisDigest(reordered)).toBe(input.manifest.analysisSha256);
  });

  test("rejects mismatched meeting identity", () => {
    const input = runFixture();
    input.manifest.meetingId = "another-meeting";
    expect(runImportSchema.safeParse(input).success).toBe(false);
  });

  test("rejects contradictory provider and transport provenance", () => {
    const input = runFixture();
    input.manifest.contextProvider = "bluedot";
    input.manifest.contextTransport = "mcp";
    expect(runImportSchema.safeParse(input).success).toBe(false);

    const impossible = runFixture();
    impossible.manifest.contextTransport = "mcp";
    expect(runImportSchema.safeParse(impossible).success).toBe(false);

    const impossibleMedia = runFixture();
    impossibleMedia.manifest.mediaSource = "bluedot-mcp";
    expect(runImportSchema.safeParse(impossibleMedia).success).toBe(false);

    const audio = runFixture();
    audio.manifest.recordingMimeType = "audio/mp4";
    expect(runImportSchema.safeParse(audio).success).toBe(false);
  });

  test("rejects mismatched recipe labels", () => {
    const input = runFixture();
    input.manifest.recipe.label = "Different label";
    expect(runImportSchema.safeParse(input).success).toBe(false);
  });

  test("rejects malformed and reversed durable timestamps", () => {
    const malformed = runFixture();
    malformed.analysis.items[0]!.candidate.start = "not-a-time";
    expect(runImportSchema.safeParse(malformed).success).toBe(false);

    const reversed = runFixture();
    reversed.analysis.items[0]!.candidate.start = "00:00:30";
    reversed.analysis.items[0]!.candidate.end = "00:00:20";
    expect(runImportSchema.safeParse(reversed).success).toBe(false);
  });

  test("rejects evidence outside its candidate and reversed run dates", () => {
    const evidence = runFixture();
    evidence.analysis.items[0]!.result.evidence = { timestamp: "00:30:00" };
    expect(runImportSchema.safeParse(evidence).success).toBe(false);

    const dates = runFixture();
    dates.manifest.startedAt = "2026-07-25T13:00:00.000Z";
    dates.manifest.completedAt = "2026-07-25T12:00:00.000Z";
    expect(runImportSchema.safeParse(dates).success).toBe(false);
  });

  test("rejects credential-bearing evidence URLs", () => {
    const input = runFixture();
    input.analysis.items[0]!.result.where = {
      appUrl: "https://user:password@example.test/path?access_token=secret",
    };
    expect(runImportSchema.safeParse(input).success).toBe(false);

    const signed = runFixture();
    signed.analysis.items[0]!.result.where = {
      appUrl: "https://example.test/file?sig=signed-secret",
    };
    expect(runImportSchema.safeParse(signed).success).toBe(false);

    const fragment = runFixture();
    fragment.analysis.items[0]!.result.where = {
      appUrl: "https://example.test/callback#access_token=fragment-secret",
    };
    expect(runImportSchema.safeParse(fragment).success).toBe(false);
  });

  test("accepts only route-safe run IDs", () => {
    const input = runFixture();
    input.manifest.runId = "run/with/slash";
    input.analysis.runId = "run/with/slash";
    expect(runImportSchema.safeParse(input).success).toBe(false);
  });
});
