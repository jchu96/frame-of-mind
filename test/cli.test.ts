import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnalyzeOptions } from "../src/cli.js";

const baseFlags = {
  source: "none",
  granolaTransport: "mcp",
  recipe: "communication-coaching",
  video: "package.json",
  depth: "deep",
  model: "gemini-pro-latest",
  output: ".frame-of-mind/test-runs",
  maxMoments: "5",
  screenshots: false,
  derivedTranscript: true,
};

describe("analyze CLI option assembly", () => {
  it("propagates explicit video-only, deep, and model options", async () => {
    const options = await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key");

    expect(options).toMatchObject({
      contextMode: "none",
      video: "package.json",
      model: "gemini-pro-latest",
      indexFps: 1,
      maxIncidents: 5,
      recipe: { id: "communication-coaching" },
    });
    expect(options.recipeRevision).toContain("deep-understanding-v1");
  });

  it("keeps derived transcription on by default and honors the opt-out", async () => {
    const defaulted = await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key");
    expect(defaulted.derivedTranscript).toBe(true);

    const disabled = await buildAnalyzeOptions(undefined, {
      ...baseFlags,
      derivedTranscript: false,
    }, "synthetic-key");
    expect(disabled.derivedTranscript).toBe(false);
  });

  describe("detail concurrency", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("defaults to 1, reads the environment, and lets the flag win", async () => {
      vi.stubEnv("FRAME_OF_MIND_DETAIL_CONCURRENCY", undefined);
      expect((await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key")).detailConcurrency).toBe(1);
      vi.stubEnv("FRAME_OF_MIND_DETAIL_CONCURRENCY", "4");
      expect((await buildAnalyzeOptions(undefined, baseFlags, "synthetic-key")).detailConcurrency).toBe(4);
      expect((await buildAnalyzeOptions(undefined, {
        ...baseFlags,
        concurrency: "8",
      }, "synthetic-key")).detailConcurrency).toBe(8);
    });

    it("rejects values outside 1-8 from the flag or the environment", async () => {
      vi.stubEnv("FRAME_OF_MIND_DETAIL_CONCURRENCY", undefined);
      for (const concurrency of ["0", "9", "1.5", "two", "-1", ""]) {
        await expect(buildAnalyzeOptions(undefined, { ...baseFlags, concurrency }, "synthetic-key"))
          .rejects.toThrow("--concurrency must be an integer from 1 to 8.");
      }
      vi.stubEnv("FRAME_OF_MIND_DETAIL_CONCURRENCY", "12");
      await expect(buildAnalyzeOptions(undefined, baseFlags, "synthetic-key"))
        .rejects.toThrow("FRAME_OF_MIND_DETAIL_CONCURRENCY must be an integer from 1 to 8.");
    });
  });

  it("requires a meeting ID when context is selected", async () => {
    await expect(buildAnalyzeOptions(undefined, {
      ...baseFlags,
      source: "bluedot",
      recipe: "issue-review",
      depth: "standard",
    }, "synthetic-key")).rejects.toThrow("meeting/note ID is required");
  });
});

describe("retention validation", () => {
  it("refuses invalid retention before any provider call", async () => {
    await expect(buildAnalyzeOptions(undefined, { ...baseFlags, retention: "idle:2h" }, "synthetic-key"))
      .rejects.toThrow("Upload retention must be");
  });
});

describe("summary", () => {
  it("the first summary line names interrogated, indexed and dropped counts", async () => {
    const { printAnalysisSummary } = await import("../src/cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      printAnalysisSummary({
        directory: "synthetic-run", analysis: { items: [] }, manifest: {},
        outcome: { status: "partial", candidates: { indexed: 57, selected: 10, omittedByLimit: 47, accepted: 0, rejected: 10, validated: 10, failed: 0 } },
      } as Parameters<typeof printAnalysisSummary>[0]);
      expect(stdout.mock.calls.map(([text]) => text).join("").split("\n")[0]).toBe(
        "Interrogated 10 of 57 indexed candidates (47 lower-importance dropped; --max-moments all to analyse every one).",
      );
    } finally { stdout.mockRestore(); }
  });
});

describe("notes", () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  async function noteFile(content: string | Buffer) {
    const root = await mkdtemp(join(tmpdir(), "fom-notes-")); directories.push(root);
    const path = join(root, "reference.md"); await writeFile(path, content); return path;
  }
  it("a 65 KiB note is refused before any provider call", async () => {
    const path = await noteFile("x".repeat(65 * 1024)); const provider = vi.fn();
    await expect(buildAnalyzeOptions(undefined, { ...baseFlags, note: [`brief=${path}`] }, "synthetic-key").then(provider))
      .rejects.toThrow("64 KiB");
    expect(provider).not.toHaveBeenCalled();
  });
  it.each(["bad-name", "duplicate", "nine", "binary", "invalid-utf8"])("refuses %s before any provider call", async kind => {
    const path = await noteFile(kind === "binary" ? Buffer.from([0, 1, 2]) : kind === "invalid-utf8" ? Buffer.from([0xff]) : "reference");
    const note = kind === "bad-name" ? [`BAD=${path}`] : kind === "duplicate" ? [`brief=${path}`, `brief=${path}`]
      : kind === "nine" ? Array.from({ length: 9 }, (_, i) => `note${i}=${path}`) : [`brief=${path}`];
    const provider = vi.fn();
    await expect(buildAnalyzeOptions(undefined, { ...baseFlags, note }, "synthetic-key").then(provider)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });
  it("accepts all as the complete indexed population", async () => {
    const options = await buildAnalyzeOptions(undefined, { ...baseFlags, maxMoments: "all" }, "synthetic-key");
    expect(options.maxIncidents).toBe(1000);
  });
});
