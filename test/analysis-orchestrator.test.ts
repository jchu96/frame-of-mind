import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { File as GeminiFile } from "@google/genai";
import type {
  AnalysisDetail,
  AnalysisRecipe,
  IndexedMoment,
  MeetingContextSource,
  MeetingEvidence,
} from "../src/domain/types.js";
import {
  AnalysisCanceledError,
  AnalysisOrchestrator,
  type AnalysisProgressEvent,
  type AnalysisVideoAnalyzer,
} from "../src/services/analyze.js";
import { CandidateAnalysisError } from "../src/domain/analysis-outcome.js";
import { GeminiFileError } from "../src/adapters/gemini-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("AnalysisOrchestrator", () => {
  describe("video duration preflight", () => {
    afterEach(() => vi.unstubAllEnvs());

    async function durationFixture(duration: number | undefined) {
      vi.stubEnv("FRAME_OF_MIND_MAX_VIDEO_SECONDS", undefined);
      const fixture = await createFixture();
      fixture.meeting.transcript = undefined;
      const analyzer = {
        ...fixture.analyzer,
        transcribe: vi.fn(async () => [
          { start: "00:00:02", end: "00:00:04", speaker: "Speaker 1", text: "Please add the report." },
        ]),
      };
      const createAnalyzer = vi.fn(() => analyzer);
      const probeDurationSeconds = vi.fn(async () => duration);
      const extractAudioTrack = vi.fn(async (_video: string, destination: string) => {
        await writeFile(destination, "synthetic-audio");
        return true;
      });
      const orchestrator = new AnalysisOrchestrator({
        createContextSource: () => fixture.context,
        createAnalyzer,
        createRunId: () => "duration-run",
        sleep: async () => undefined,
        probeDurationSeconds,
        extractAudioTrack,
      });
      return { ...fixture, analyzer, createAnalyzer, probeDurationSeconds, extractAudioTrack, orchestrator };
    }

    it("refuses 9000 seconds with hours and remedies before transcription, upload, or run creation", async () => {
      const fixture = await durationFixture(9000);
      await expect(fixture.orchestrator.analyze(fixture.options)).rejects.toThrow(
        "Recording is 2.5 h; the selected model's video window is 2.0 h at this media resolution. " +
          "Split the recording or lower media resolution.",
      );
      expect(fixture.probeDurationSeconds).toHaveBeenCalledTimes(1);
      expect(fixture.createAnalyzer).not.toHaveBeenCalled();
      expect(fixture.extractAudioTrack).not.toHaveBeenCalled();
      expect(fixture.analyzer.transcribe).not.toHaveBeenCalled();
      expect(fixture.analyzer.upload).not.toHaveBeenCalled();
      await expect(stat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(fixture.options.video!, "utf8")).toBe("synthetic-video");
      expect(fixture.context.close).toHaveBeenCalledTimes(1);
    });

    it("keeps unknown duration to one transcription window and uploads the video", async () => {
      const fixture = await durationFixture(undefined);
      const signal = new AbortController().signal;
      await fixture.orchestrator.analyze(fixture.options, { signal });
      expect(fixture.probeDurationSeconds).toHaveBeenCalledExactlyOnceWith(fixture.options.video, { signal });
      expect(fixture.extractAudioTrack).toHaveBeenCalledExactlyOnceWith(
        fixture.options.video, expect.stringContaining("derived-audio-1.aac"), { signal },
      );
      expect(fixture.analyzer.transcribe).toHaveBeenCalledTimes(1);
      expect(fixture.analyzer.upload).toHaveBeenCalledTimes(2);
      expect(fixture.analyzer.upload).toHaveBeenLastCalledWith(fixture.options.video, "video/mp4");
    });

    it("allows exactly 7200 seconds and reuses the probe for transcription windows", async () => {
      const fixture = await durationFixture(7200);
      await fixture.orchestrator.analyze(fixture.options);
      expect(fixture.probeDurationSeconds).toHaveBeenCalledTimes(1);
      expect(fixture.analyzer.transcribe).toHaveBeenCalledTimes(12);
      expect(fixture.analyzer.upload).toHaveBeenLastCalledWith(fixture.options.video, "video/mp4");
    });

    it("refuses 7201 seconds even when derived transcription is disabled", async () => {
      const fixture = await durationFixture(7201);
      await expect(fixture.orchestrator.analyze({ ...fixture.options, derivedTranscript: false }))
        .rejects.toThrow("video window is 2.0 h");
      expect(fixture.createAnalyzer).not.toHaveBeenCalled();
      expect(fixture.analyzer.upload).not.toHaveBeenCalled();
    });

    it("allows 9000 seconds with FRAME_OF_MIND_MAX_VIDEO_SECONDS=10000", async () => {
      const fixture = await durationFixture(9000);
      vi.stubEnv("FRAME_OF_MIND_MAX_VIDEO_SECONDS", "10000");
      await fixture.orchestrator.analyze(fixture.options);
      expect(fixture.probeDurationSeconds).toHaveBeenCalledTimes(1);
      expect(fixture.analyzer.transcribe).toHaveBeenCalledTimes(15);
      expect(fixture.analyzer.upload).toHaveBeenLastCalledWith(fixture.options.video, "video/mp4");
      // Resolve the environment afresh on each run, even with the same instance.
      vi.stubEnv("FRAME_OF_MIND_MAX_VIDEO_SECONDS", "7200");
      await expect(fixture.orchestrator.analyze(fixture.options)).rejects.toThrow("video window is 2.0 h");
      expect(fixture.createAnalyzer).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid FRAME_OF_MIND_MAX_VIDEO_SECONDS before any probe or context work", async () => {
      const fixture = await durationFixture(9000);
      for (const value of ["0", "-1", "invalid", "", "1.5", "Infinity", "1e4", "9007199254740992"]) {
        vi.stubEnv("FRAME_OF_MIND_MAX_VIDEO_SECONDS", value);
        await expect(fixture.orchestrator.analyze(fixture.options)).rejects.toThrow(
          "FRAME_OF_MIND_MAX_VIDEO_SECONDS must be a positive integer number of seconds",
        );
      }
      expect(fixture.probeDurationSeconds).not.toHaveBeenCalled();
      expect(fixture.context.connect).not.toHaveBeenCalled();
      expect(fixture.createAnalyzer).not.toHaveBeenCalled();
      await expect(stat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("honors cancellation during the probe before creating a run or analyzer", async () => {
      const fixture = await durationFixture(undefined);
      const controller = new AbortController();
      fixture.probeDurationSeconds.mockImplementation(async () => {
        controller.abort();
        return undefined;
      });
      await expect(fixture.orchestrator.analyze(fixture.options, { signal: controller.signal }))
        .rejects.toBeInstanceOf(AnalysisCanceledError);
      expect(fixture.probeDurationSeconds).toHaveBeenCalledExactlyOnceWith(
        fixture.options.video, { signal: controller.signal },
      );
      expect(fixture.createAnalyzer).not.toHaveBeenCalled();
      await expect(stat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("uses an explicit staged MIME type before hashing an extensionless recording", async () => {
    const fixture = await createFixture();
    const sealedVideo = join(fixture.outputRoot, "..", "media.sealed");
    await writeFile(sealedVideo, "synthetic-sealed-video");
    const orchestrator = createOrchestrator(fixture);

    await expect(orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: sealedVideo,
      videoMimeType: "video/webm",
      expectedVideoSha256: "f".repeat(64),
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
      derivedTranscript: false,
    })).rejects.toThrow(
      "Selected recording no longer matches its staged media receipt.",
    );
    expect(fixture.analyzer.upload).not.toHaveBeenCalled();
  });

  it("publishes video-only v3 provenance without touching a context provider", async () => {
    const fixture = await createFixture();
    const createContextSource = vi.fn(() => fixture.context);
    const publishProjection = vi.fn(async () => undefined);
    const events: AnalysisProgressEvent[] = [];
    const orchestrator = new AnalysisOrchestrator({
      createContextSource,
      createAnalyzer: () => fixture.analyzer,
      createRunId: () => "video-only-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      model: fixture.options.model,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    }, {
      progress: { report: (event) => events.push(event) },
      projection: { publish: publishProjection },
    });

    expect(createContextSource).not.toHaveBeenCalled();
    expect(fixture.context.connect).not.toHaveBeenCalled();
    expect(fixture.context.meeting).not.toHaveBeenCalled();
    expect(fixture.context.close).not.toHaveBeenCalled();
    expect(publishProjection).toHaveBeenCalledWith(expect.objectContaining({
      analysis: expect.objectContaining({ schemaVersion: 3 }),
      manifest: expect.objectContaining({ schemaVersion: 3 }),
    }));
    expect(events[0]).toMatchObject({
      kind: "stage",
      stage: "fetching_context",
      message: "No external context selected.",
    });
    expect(fixture.analyzer.index).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      fixture.options.recipe,
      undefined,
      0.5,
      undefined,
    );
    expect(fixture.analyzer.interrogate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      undefined,
      fixture.options.recipe,
      undefined,
      false,
    );
    expect(result.analysis).toMatchObject({
      schemaVersion: 3,
      context: { mode: "none" },
    });
    expect(result.manifest).toMatchObject({
      schemaVersion: 3,
      context: { mode: "none" },
      mediaSource: "local-file",
    });
    expect(result.manifest).not.toHaveProperty("meetingId");
    expect(result.manifest).not.toHaveProperty("transcriptSha256");
    expect(result.manifest).not.toHaveProperty("transcriptAlignment");
    expect(result.manifest).not.toHaveProperty("derivedTranscript");
    expect(result.projectionWarning).toBeUndefined();
  });

  it("derives a transcript for a video-only run and records provenance", async () => {
    const fixture = await createFixture();
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => [
        { start: "00:00:02", end: "00:00:04", speaker: "Speaker 1", text: "Please add the report." },
      ]),
    };
    const extractAudioTrack = vi.fn(async (_video: string, destination: string) => {
      await writeFile(destination, "synthetic-audio");
      return true;
    });
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "derived-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
      probeDurationSeconds: async () => 420,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    });

    const derivedLine = "[00:00:02] Speaker 1: Please add the report.";
    expect(extractAudioTrack).toHaveBeenCalledTimes(1);
    expect(analyzer.upload).toHaveBeenCalledWith(
      expect.stringContaining("derived-audio-1.aac"),
      "audio/aac",
    );
    expect(analyzer.transcribe).toHaveBeenCalledTimes(1);
    // Audio remote cleanup plus final recording cleanup.
    expect(analyzer.delete).toHaveBeenCalledTimes(2);
    expect(analyzer.index).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      fixture.options.recipe,
      undefined,
      0.5,
      derivedLine,
    );
    expect(analyzer.interrogate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      derivedLine,
      fixture.options.recipe,
      undefined,
      true,
    );
    expect(result.manifest.schemaVersion).toBe(3);
    expect(result.manifest.derivedTranscript).toMatchObject({
      origin: "gemini-audio",
      model: "gemini-test",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("transcribes a long recording in windows and stitches recording time", async () => {
    const fixture = await createFixture();
    // Each window is transcribed independently and reports chunk-relative
    // times; the second window re-transcribes its lead-in overlap.
    const perWindow = [
      [
        { start: "00:00:02", end: "00:00:05", speaker: "Speaker 1", text: "Please add the report." },
        { start: "00:09:56", end: "00:09:59", speaker: "Speaker 2", text: "Boundary sentence." },
      ],
      [
        { start: "00:00:11", end: "00:00:14", speaker: "Speaker 2", text: "Boundary sentence." },
        { start: "00:00:20", end: "00:00:24", speaker: "Speaker 1", text: "Second window line." },
      ],
    ];
    let transcribeCall = 0;
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => perWindow[transcribeCall++] ?? []),
    };
    const windows: Array<{ startSeconds?: number; durationSeconds?: number }> = [];
    const extractAudioTrack = vi.fn(async (
      _video: string,
      destination: string,
      options?: { startSeconds?: number; durationSeconds?: number },
    ) => {
      windows.push({
        startSeconds: options?.startSeconds,
        durationSeconds: options?.durationSeconds,
      });
      await writeFile(destination, "synthetic-audio");
      return true;
    });
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "chunked-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
      probeDurationSeconds: async () => 900,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    });

    expect(windows).toEqual([
      { startSeconds: undefined, durationSeconds: 600 },
      { startSeconds: 585, durationSeconds: 315 },
    ]);
    expect(analyzer.transcribe).toHaveBeenCalledTimes(2);
    // One delete per window audio upload, plus the final recording cleanup.
    expect(analyzer.delete).toHaveBeenCalledTimes(3);
    const stitched = [
      "[00:00:02] Speaker 1: Please add the report.",
      "[00:09:56] Speaker 2: Boundary sentence.",
      "[00:10:05] Speaker 1: Second window line.",
    ].join("\n");
    expect(analyzer.index).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      fixture.options.recipe,
      undefined,
      0.5,
      stitched,
    );
    expect(result.manifest.derivedTranscript).toMatchObject({ origin: "gemini-audio" });
  });

  it("retries a window that exhausts its request retries and keeps the transcript", async () => {
    const fixture = await createFixture();
    // Window 1 is shed once, mirroring a provider load-shedding episode that
    // outlasts the adapter's own per-request retry budget.
    let calls = 0;
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("provider body");
        return [{ start: "00:00:02", end: "00:00:05", speaker: "Speaker 1", text: "Recovered window." }];
      }),
    };
    const extractAudioTrack = vi.fn(async (_video: string, destination: string) => {
      await writeFile(destination, "synthetic-audio");
      return true;
    });
    const delays: number[] = [];
    const events: AnalysisProgressEvent[] = [];
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "window-retry-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      extractAudioTrack,
      probeDurationSeconds: async () => 420,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    }, { progress: { report: (event) => events.push(event) } });

    expect(analyzer.transcribe).toHaveBeenCalledTimes(2);
    // The audio is extracted once and reused by the retry.
    expect(extractAudioTrack).toHaveBeenCalledTimes(1);
    // Both audio uploads are deleted, plus the recording.
    expect(analyzer.delete).toHaveBeenCalledTimes(3);
    expect(delays).toContain(20_000);
    expect(result.manifest.derivedTranscript).toMatchObject({ origin: "gemini-audio" });
    expect(analyzer.index).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      fixture.options.recipe,
      undefined,
      0.5,
      "[00:00:02] Speaker 1: Recovered window.",
    );
    const retryWarning = events.find((event) =>
      event.kind === "warning" && event.message.includes("retrying once"),
    );
    expect(retryWarning).toBeDefined();
    expect(retryWarning && "message" in retryWarning ? retryWarning.message : "")
      .not.toContain("provider body");
  });

  it("publishes no transcript when one window fails rather than a transcript with a hole", async () => {
    const fixture = await createFixture();
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => {
        // Window 1 succeeds; window 2 fails on both of its attempts.
        if (analyzer.transcribe.mock.calls.length > 1) throw new Error("provider body");
        return [{ start: "00:00:02", end: "00:00:05", speaker: "Speaker 1", text: "First window." }];
      }),
    };
    const extractAudioTrack = vi.fn(async (_video: string, destination: string) => {
      await writeFile(destination, "synthetic-audio");
      return true;
    });
    const events: AnalysisProgressEvent[] = [];
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "partial-transcript-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
      probeDurationSeconds: async () => 900,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    }, { progress: { report: (event) => events.push(event) } });

    expect(result.manifest).not.toHaveProperty("derivedTranscript");
    expect(analyzer.index).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      fixture.options.recipe,
      undefined,
      0.5,
      undefined,
    );
    const warning = events.find((event) =>
      event.kind === "warning"
      && event.message.includes("audio window 2/2")
      && event.message.includes("after 2 attempts"),
    );
    expect(warning).toBeDefined();
    expect(warning && "message" in warning ? warning.message : "").not.toContain("provider body");
  });

  it("skips derived transcription when the operator disables it", async () => {
    const fixture = await createFixture();
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => []),
    };
    const extractAudioTrack = vi.fn(async () => true);
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "derived-off-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      derivedTranscript: false,
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    });

    expect(extractAudioTrack).not.toHaveBeenCalled();
    expect(analyzer.transcribe).not.toHaveBeenCalled();
    expect(result.manifest).not.toHaveProperty("derivedTranscript");
  });

  it("continues without a transcript when derived transcription fails", async () => {
    const fixture = await createFixture();
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => {
        throw new Error("synthetic transcription failure");
      }),
    };
    const extractAudioTrack = vi.fn(async (_video: string, destination: string) => {
      await writeFile(destination, "synthetic-audio");
      return true;
    });
    const events: AnalysisProgressEvent[] = [];
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "derived-failure-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    }, {
      progress: { report: (event) => events.push(event) },
    });

    // One retry of the whole window, then the transcript is abandoned.
    expect(analyzer.transcribe).toHaveBeenCalledTimes(2);
    expect(events.some((event) =>
      event.kind === "warning"
      && event.message.includes("retrying once"))).toBe(true);
    expect(events.some((event) =>
      event.kind === "warning"
      && event.message.includes("after 2 attempts; continuing without a transcript"))).toBe(true);
    // Audio remote cleanup on both attempts plus final recording cleanup.
    expect(analyzer.delete).toHaveBeenCalledTimes(3);
    expect(result.manifest).not.toHaveProperty("derivedTranscript");
    expect(analyzer.index).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      fixture.options.recipe,
      undefined,
      0.5,
      undefined,
    );
  });

  it("fills an empty file-context transcript and pins alignment at zero", async () => {
    const fixture = await createFixture();
    fixture.meeting.transcript = "";
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => [
        { start: "00:00:02", end: "00:00:04", speaker: "Speaker 1", text: "Please add the report." },
      ]),
    };
    const extractAudioTrack = vi.fn(async (_video: string, destination: string) => {
      await writeFile(destination, "synthetic-audio");
      return true;
    });
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "derived-fill-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
    });

    const result = await orchestrator.analyze(fixture.options);

    const derivedLine = "[00:00:02] Speaker 1: Please add the report.";
    expect(analyzer.index).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ transcript: "" }),
      fixture.options.recipe,
      undefined,
      0.5,
      derivedLine,
    );
    expect(analyzer.interrogate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      derivedLine,
      fixture.options.recipe,
      undefined,
      true,
    );
    expect(result.manifest.schemaVersion).toBe(2);
    if (result.manifest.schemaVersion !== 2) throw new Error("expected v2 manifest");
    expect(result.manifest.transcriptAlignment).toMatchObject({
      offsetSeconds: 0,
      method: "explicit",
      confidence: "high",
    });
    expect(result.manifest.derivedTranscript).toMatchObject({ origin: "gemini-audio" });
    expect(result.manifest.transcriptSha256).toBe(result.manifest.derivedTranscript!.sha256);
  });

  it("never re-derives over a real provider transcript", async () => {
    const fixture = await createFixture();
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => [
        { start: "00:00:02", end: "00:00:04", speaker: "Speaker 9", text: "Should never be used." },
      ]),
    };
    const extractAudioTrack = vi.fn(async () => true);
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "gate-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
    });

    const result = await orchestrator.analyze(fixture.options);

    expect(extractAudioTrack).not.toHaveBeenCalled();
    expect(analyzer.transcribe).not.toHaveBeenCalled();
    expect(result.manifest).not.toHaveProperty("derivedTranscript");
    if (result.manifest.schemaVersion !== 2) throw new Error("expected v2 manifest");
    expect(result.manifest.transcriptAlignment.method).toBe("model");
    expect(analyzer.interrogate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(String),
      fixture.options.recipe,
      undefined,
      false,
    );
  });

  it("continues to the video passes when the audio upload fails", async () => {
    const fixture = await createFixture();
    const remote = fixture.analyzer.upload;
    let uploadCalls = 0;
    const analyzer = {
      ...fixture.analyzer,
      upload: vi.fn(async (path: string, mimeType: string) => {
        uploadCalls += 1;
        if (mimeType === "audio/aac") {
          throw new GeminiFileError("Gemini file upload or processing failed.", undefined, "unconfirmed");
        }
        return remote.getMockImplementation()!(path, mimeType);
      }),
      transcribe: vi.fn(async () => []),
    };
    const extractAudioTrack = vi.fn(async (_video: string, destination: string) => {
      await writeFile(destination, "synthetic-audio");
      return true;
    });
    const events: AnalysisProgressEvent[] = [];
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "audio-upload-failure-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    }, {
      progress: { report: (event) => events.push(event) },
    });

    // Two audio upload attempts for the single window, then the video upload.
    expect(uploadCalls).toBe(3);
    expect(analyzer.transcribe).not.toHaveBeenCalled();
    expect(events.some((event) =>
      event.kind === "warning"
      && event.message.includes("after 2 attempts; continuing without a transcript"))).toBe(true);
    expect(events.some((event) =>
      event.kind === "warning" && event.message.includes("retention window"))).toBe(true);
    expect(result.manifest).not.toHaveProperty("derivedTranscript");
    expect(result.manifest.schemaVersion).toBe(3);
  });

  it("propagates cancellation during derived transcription and cleans up the audio upload", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => {
        controller.abort();
        throw new AnalysisCanceledError();
      }),
    };
    const extractAudioTrack = vi.fn(async (_video: string, destination: string) => {
      await writeFile(destination, "synthetic-audio");
      return true;
    });
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "derived-cancel-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
    });

    await expect(orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    }, {
      signal: controller.signal,
    })).rejects.toBeInstanceOf(AnalysisCanceledError);

    // The audio remote is still cleaned up in the finally path.
    expect(analyzer.delete).toHaveBeenCalledTimes(1);
    expect(analyzer.index).not.toHaveBeenCalled();
  });

  it("records no provenance when transcription returns no segments", async () => {
    const fixture = await createFixture();
    const analyzer = {
      ...fixture.analyzer,
      transcribe: vi.fn(async () => []),
    };
    const extractAudioTrack = vi.fn(async (_video: string, destination: string) => {
      await writeFile(destination, "synthetic-audio");
      return true;
    });
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "derived-empty-run",
      now: () => "2026-07-28T12:00:00.000Z",
      sleep: async () => undefined,
      extractAudioTrack,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
    });

    expect(analyzer.transcribe).toHaveBeenCalledTimes(1);
    // Audio remote cleanup plus final recording cleanup still happen.
    expect(analyzer.delete).toHaveBeenCalledTimes(2);
    expect(result.manifest).not.toHaveProperty("derivedTranscript");
    expect(analyzer.index).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      fixture.options.recipe,
      undefined,
      0.5,
      undefined,
    );
  });

  it("publishes a valid run and reports structured progress", async () => {
    const fixture = await createFixture();
    const events: AnalysisProgressEvent[] = [];
    const projected: string[] = [];
    const orchestrator = createOrchestrator(fixture);

    const result = await orchestrator.analyze(fixture.options, {
      progress: {
        report(event) {
          events.push(event);
        },
      },
      projection: {
        async publish(run) {
          projected.push(run.analysis.runId);
        },
      },
    });

    expect(events.map((event) => event.stage)).toEqual([
      "fetching_context",
      "uploading_to_gemini",
      "indexing",
      "interrogating",
      "interrogating",
      "rendering",
      "cleaning_up",
    ]);
    expect(events[4]).toMatchObject({
      kind: "progress",
      progress: { completed: 1, total: 1, unit: "items" },
    });
    expect(projected).toEqual([result.analysis.runId]);
    expect(result.projectionWarning).toBeUndefined();
    expect(result.manifest.remoteFile?.deleted).toBe(true);
    await expect(
      stat(join(result.directory, "analysis.json")),
    ).resolves.toBeDefined();
    await expect(
      stat(join(result.directory, "manifest.json")),
    ).resolves.toBeDefined();
    expect(
      JSON.parse(
        await readFile(join(result.directory, "analysis.json"), "utf8"),
      ),
    ).toEqual(result.analysis);
  });

  it("passes the requested model into analyzer construction", async () => {
    const fixture = await createFixture();
    let requestedModel: string | undefined;
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: (_apiKey, options) => {
        requestedModel = options.model;
        return fixture.analyzer;
      },
      createRunId: () => "run-model-test",
      now: () => "2026-07-27T12:00:00.000Z",
      sleep: async () => undefined,
    });

    await orchestrator.analyze({
      ...fixture.options,
      model: "gemini-test",
    });

    expect(requestedModel).toBe("gemini-test");
  });

  it("records the selected whole-video sampling rate in provenance", async () => {
    const fixture = await createFixture();
    const result = await createOrchestrator(fixture).analyze({
      ...fixture.options,
      indexFps: 1,
    });

    expect(fixture.analyzer.index).toHaveBeenCalledWith(
      expect.any(Object),
      fixture.meeting,
      fixture.options.recipe,
      undefined,
      1,
      undefined,
    );
    expect(result.manifest.analysis.indexFps).toBe(1);
  });

  it("rejects staged media whose bytes no longer match its receipt", async () => {
    const fixture = await createFixture();

    await expect(createOrchestrator(fixture).analyze({
      ...fixture.options,
      expectedVideoSha256: "f".repeat(64),
    })).rejects.toThrow(
      "Selected recording no longer matches its staged media receipt.",
    );
    expect(fixture.analyzer.upload).not.toHaveBeenCalled();
  });

  it("does not downgrade a failed meeting context request to video-only", async () => {
    const fixture = await createFixture();
    fixture.context.meeting = vi.fn(
      async () => undefined as unknown as MeetingEvidence,
    );

    await expect(createOrchestrator(fixture).analyze(fixture.options))
      .rejects.toThrow("Meeting context provider returned no meeting evidence.");
    expect(fixture.analyzer.upload).not.toHaveBeenCalled();
  });

  it("preserves the durable run when projection publication fails", async () => {
    const fixture = await createFixture();
    const events: AnalysisProgressEvent[] = [];
    const result = await createOrchestrator(fixture).analyze(fixture.options, {
      progress: { report: (event) => events.push(event) },
      projection: {
        async publish() {
          throw new Error("sqlite path and secret details");
        },
      },
    });

    expect(result.projectionWarning).toBe(
      "Published run could not be added to the review projection.",
    );
    expect(events.at(-1)).toMatchObject({
      kind: "warning",
      stage: "cleaning_up",
      message: "Published run could not be added to the review projection.",
    });
    await expect(
      stat(join(result.directory, "manifest.json")),
    ).resolves.toBeDefined();
  });

  it("isolates the authoritative result from projection-side mutation", async () => {
    const fixture = await createFixture();
    const result = await createOrchestrator(fixture).analyze(fixture.options, {
      projection: {
        async publish(run) {
          run.analysis.meeting.id = "mutated-by-projection";
          run.manifest.meetingId = "mutated-by-projection";
        },
      },
    });

    expect(result.analysis.meeting.id).toBe(fixture.meeting.id);
    expect(result.manifest.meetingId).toBe(fixture.meeting.id);
    const persistedAnalysis = JSON.parse(
      await readFile(join(result.directory, "analysis.json"), "utf8"),
    );
    expect(persistedAnalysis.meeting.id).toBe(fixture.meeting.id);
  });

  it("rejects an unsafe injected run ID before touching providers or paths", async () => {
    const fixture = await createFixture();
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => fixture.analyzer,
      createRunId: () => "../../../outside-run-root",
      now: () => "2026-07-27T12:00:00.000Z",
    });

    await expect(orchestrator.analyze(fixture.options)).rejects.toThrow(
      "Generated run ID is not a safe path segment.",
    );
    expect(fixture.context.connect).not.toHaveBeenCalled();
    expect(fixture.analyzer.upload).not.toHaveBeenCalled();
  });

  it("cancels between provider boundaries and still deletes the remote upload", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    fixture.analyzer.index = vi.fn(async () => {
      controller.abort();
      return indexResult();
    });

    await expect(
      createOrchestrator(fixture).analyze(fixture.options, {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AnalysisCanceledError);

    expect(fixture.analyzer.delete).toHaveBeenCalledTimes(1);
    await expect(
      stat(join(fixture.outputRoot, fixture.meeting.id)),
    ).rejects.toThrow();
  });

  it("cleans up when cancellation arrives while upload is completing", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const remote: GeminiFile = {
      name: "files/canceled-upload",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/canceled-upload",
      mimeType: "video/mp4",
      state: "ACTIVE",
    };
    fixture.analyzer.upload = vi.fn(async () => {
      controller.abort();
      return remote;
    });

    await expect(
      createOrchestrator(fixture).analyze(fixture.options, {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AnalysisCanceledError);

    expect(fixture.analyzer.index).not.toHaveBeenCalled();
    expect(fixture.analyzer.delete).toHaveBeenCalledTimes(1);
  });

  it("does not publish when cancellation coincides with an upload failure", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    fixture.analyzer.upload = vi.fn(async () => {
      controller.abort();
      throw new GeminiFileError(
        "Gemini upload failed after cancellation.",
        "files/canceled-upload",
        "confirmed_deleted",
      );
    });

    await expect(
      createOrchestrator(fixture).analyze(fixture.options, {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AnalysisCanceledError);

    await expect(stat(join(fixture.outputRoot, fixture.meeting.id)))
      .rejects.toThrow();
  });

  it("deletes the remote upload and publishes a sanitized failure manifest after an unexpected analysis failure", async () => {
    const fixture = await createFixture();
    const privateProviderPayload = "private-provider-payload-must-not-persist";
    fixture.analyzer.interrogate = vi.fn(async () => {
      throw new Error(
        `Gemini adapter invariant failed: ${privateProviderPayload}`,
      );
    });

    await expect(
      createOrchestrator(fixture).analyze(fixture.options),
    ).rejects.toThrow(privateProviderPayload);

    expect(fixture.analyzer.delete).toHaveBeenCalledTimes(1);
    const receiptPath = join(
      fixture.outputRoot,
      fixture.meeting.id,
      "run-test",
      "failure-manifest.json",
    );
    const receipt = await readFile(receiptPath, "utf8");
    expect(JSON.parse(receipt)).toMatchObject({
      schemaVersion: 1,
      runId: "run-test",
      status: "failed",
      phase: "detail",
      error: { code: "unexpected_failure" },
      remoteFile: { cleanup: "confirmed_deleted" },
    });
    expect(receipt).not.toContain(privateProviderPayload);
    expect(await readdir(join(
      fixture.outputRoot,
      fixture.meeting.id,
      "run-test",
    ))).toEqual(["failure-manifest.json"]);
  });

  it("publishes only sanitized schema locations when indexing exhausts repair", async () => {
    const fixture = await createFixture();
    fixture.analyzer.index = vi.fn(async () => {
      throw new CandidateAnalysisError({
        code: "schema_validation",
        attempts: 2,
        issues: [{ path: "moments.0.surface", code: "too_big" }],
        cause: new Error("private index response"),
      });
    });

    await expect(createOrchestrator(fixture).analyze(fixture.options))
      .rejects.toBeInstanceOf(CandidateAnalysisError);

    const receipt = await readFile(join(
      fixture.outputRoot,
      fixture.meeting.id,
      "run-test",
      "failure-manifest.json",
    ), "utf8");
    expect(JSON.parse(receipt)).toMatchObject({
      phase: "index",
      error: {
        code: "schema_validation",
        attempts: 2,
        issues: [{ path: "moments.0.surface", code: "too_big" }],
      },
      remoteFile: { cleanup: "confirmed_deleted" },
    });
    expect(receipt).not.toContain("private index response");
  });

  it("does not let malformed optional remote metadata mask the original failure", async () => {
    const fixture = await createFixture();
    fixture.analyzer.upload = vi.fn(async () => ({
      name: "files/test",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/test",
      mimeType: "video/mp4",
      state: "ACTIVE",
      expirationTime: "x".repeat(121),
    }));
    fixture.analyzer.interrogate = vi.fn(async () => {
      throw new Error("original-safe-failure");
    });

    await expect(createOrchestrator(fixture).analyze(fixture.options))
      .rejects.toThrow("original-safe-failure");

    const receipt = JSON.parse(await readFile(join(
      fixture.outputRoot,
      fixture.meeting.id,
      "run-test",
      "failure-manifest.json",
    ), "utf8"));
    expect(receipt.remoteFile).not.toHaveProperty("expirationTime");
    expect(receipt.remoteFile.cleanup).toBe("confirmed_deleted");
  });

  it("records unconfirmed cleanup without persisting the thrown provider error", async () => {
    const fixture = await createFixture();
    const events: AnalysisProgressEvent[] = [];
    fixture.analyzer.interrogate = vi.fn(async () => {
      throw new Error("private detail response");
    });
    fixture.analyzer.delete = vi.fn(async () => {
      throw new Error("private delete response");
    });

    await expect(createOrchestrator(fixture).analyze(fixture.options, {
      progress: { report: (event) => events.push(event) },
    }))
      .rejects.toThrow("private detail response");

    const receipt = await readFile(join(
      fixture.outputRoot,
      fixture.meeting.id,
      "run-test",
      "failure-manifest.json",
    ), "utf8");
    expect(fixture.analyzer.delete).toHaveBeenCalledTimes(3);
    expect(JSON.parse(receipt).remoteFile.cleanup).toBe("unconfirmed");
    expect(receipt).not.toContain("private detail response");
    expect(receipt).not.toContain("private delete response");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warning",
      message: expect.stringContaining("cleanup is unconfirmed"),
    }));
  });

  it("publishes upload cleanup provenance when processing fails after a remote file is obtained", async () => {
    const fixture = await createFixture();
    fixture.analyzer.upload = vi.fn(async () => {
      throw new GeminiFileError(
        "Gemini upload processing failed and remote cleanup could not be confirmed.",
        "files/upload-failure",
        "unconfirmed",
      );
    });
    const events: AnalysisProgressEvent[] = [];

    await expect(createOrchestrator(fixture).analyze(fixture.options, {
      progress: { report: (event) => events.push(event) },
    })).rejects.toThrow("remote cleanup could not be confirmed");

    const receipt = JSON.parse(await readFile(join(
      fixture.outputRoot,
      fixture.meeting.id,
      "run-test",
      "failure-manifest.json",
    ), "utf8"));
    expect(receipt).toMatchObject({
      phase: "upload",
      error: { code: "unexpected_failure" },
      remoteFile: {
        name: "files/upload-failure",
        cleanup: "unconfirmed",
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warning",
      message: expect.stringContaining("cleanup is unconfirmed"),
    }));
  });

  it("drops malformed upload identity without masking the original failure", async () => {
    const fixture = await createFixture();
    fixture.analyzer.upload = vi.fn(async () => {
      throw new GeminiFileError(
        "safe upload failure",
        "../../private-provider-name",
        "unconfirmed",
      );
    });

    await expect(createOrchestrator(fixture).analyze(fixture.options))
      .rejects.toThrow("safe upload failure");

    const receipt = JSON.parse(await readFile(join(
      fixture.outputRoot,
      fixture.meeting.id,
      "run-test",
      "failure-manifest.json",
    ), "utf8"));
    expect(receipt.remoteFile).toEqual({ cleanup: "unconfirmed" });
  });

  it("does not promise exact recovery when unconfirmed cleanup has no file name", async () => {
    const fixture = await createFixture();
    const events: AnalysisProgressEvent[] = [];
    fixture.analyzer.upload = vi.fn(async () => {
      throw new GeminiFileError(
        "upload finalization was ambiguous",
        undefined,
        "unconfirmed",
      );
    });

    await expect(createOrchestrator(fixture).analyze(fixture.options, {
      progress: { report: (event) => events.push(event) },
    })).rejects.toThrow("upload finalization was ambiguous");

    const warning = events.find((event) => event.kind === "warning");
    expect(warning).toEqual(expect.objectContaining({
      message: expect.stringContaining("identity is unavailable"),
    }));
    expect(warning).not.toEqual(expect.objectContaining({
      message: expect.stringContaining("exact-file recovery"),
    }));
  });

  it("records intentionally retained cleanup when keep-upload is explicit", async () => {
    const fixture = await createFixture();
    fixture.options.keepUpload = true;
    fixture.analyzer.interrogate = vi.fn(async () => {
      throw new Error("private detail response");
    });

    await expect(createOrchestrator(fixture).analyze(fixture.options))
      .rejects.toThrow("private detail response");

    const receipt = JSON.parse(await readFile(join(
      fixture.outputRoot,
      fixture.meeting.id,
      "run-test",
      "failure-manifest.json",
    ), "utf8"));
    expect(fixture.analyzer.delete).not.toHaveBeenCalled();
    expect(receipt.remoteFile.cleanup).toBe("intentionally_retained");
  });

  it("isolates one exhausted detail response and publishes valid candidates", async () => {
    const fixture = await createFixture();
    const privateProviderPayload = "private-provider-payload-must-not-persist";
    fixture.options.maxIncidents = 4;
    fixture.analyzer.index = vi.fn(async () => ({
      ...indexResult(),
      moments: [1, 2, 3, 4, 5].map((second) => ({
        ...indexResult().moments[0]!,
        start: `00:00:0${second}`,
        end: `00:00:0${second + 1}`,
      })),
    }));
    fixture.analyzer.interrogate = vi.fn(async (_file, candidate) => {
      if (candidate.start === "00:00:02") {
        throw new CandidateAnalysisError({
          code: "schema_validation",
          attempts: 2,
          issues: [{ path: "where.surface", code: "too_big" }],
          cause: new Error(privateProviderPayload),
        });
      }
      return {
        ...detailResult(),
        accepted: candidate.start !== "00:00:03",
        evidence: { timestamp: candidate.start },
      };
    });
    const events: AnalysisProgressEvent[] = [];

    const result = await createOrchestrator(fixture).analyze(fixture.options, {
      progress: { report: (event) => events.push(event) },
    });

    expect(result.analysis.items).toHaveLength(3);
    expect(result.outcome).toMatchObject({
      status: "partial",
      candidates: {
        indexed: 5,
        selected: 4,
        omittedByLimit: 1,
        validated: 3,
        accepted: 2,
        rejected: 1,
        failed: 1,
      },
      failures: [{
        candidateOrdinal: 2,
        start: "00:00:02",
        end: "00:00:03",
        code: "schema_validation",
        attempts: 2,
        issues: [{ path: "where.surface", code: "too_big" }],
      }],
    });
    expect(result.manifest.artifacts).toContain("analysis-outcome.json");
    expect(result.manifest.remoteFile?.deleted).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warning",
      stage: "interrogating",
      message: "Candidate 2 could not be validated after 2 attempts; continuing with remaining candidates.",
    }));
    const persisted = await readFile(
      join(result.directory, "analysis-outcome.json"),
      "utf8",
    );
    expect(JSON.parse(persisted)).toEqual(result.outcome);
    expect(persisted).not.toContain(privateProviderPayload);
  });

  it("reports omission-only truncation as partial with a coverage warning", async () => {
    const fixture = await createFixture();
    fixture.options.maxIncidents = 2;
    fixture.analyzer.index = vi.fn(async () => ({
      ...indexResult(),
      moments: [1, 2, 3].map((second) => ({
        ...indexResult().moments[0]!,
        start: `00:00:0${second}`,
        end: `00:00:0${second + 1}`,
      })),
    }));
    fixture.analyzer.interrogate = vi.fn(async (_file, candidate) => ({
      ...detailResult(),
      accepted: true,
      evidence: { timestamp: candidate.start },
    }));
    const events: AnalysisProgressEvent[] = [];

    const result = await createOrchestrator(fixture).analyze(fixture.options, {
      progress: { report: (event) => events.push(event) },
    });

    expect(result.outcome).toMatchObject({
      status: "partial",
      candidates: {
        indexed: 3,
        selected: 2,
        omittedByLimit: 1,
        validated: 2,
        accepted: 2,
        rejected: 0,
        failed: 0,
      },
      failures: [],
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warning",
      stage: "interrogating",
      message: expect.stringContaining("Analysis truncated: 1 indexed candidate(s)"),
    }));
    const persisted = JSON.parse(await readFile(
      join(result.directory, "analysis-outcome.json"),
      "utf8",
    ));
    expect(persisted.status).toBe("partial");
  });

  it("emits only vocabulary spans with content-free attributes when a tracer is injected", async () => {
    const { ANALYSIS_SPAN_NAMES, ANALYSIS_SPAN_OPS, isSafeTraceAttribute } =
      await import("../src/lib/telemetry-trace.js");
    const recorded: Array<{ op: string; name: string; attributes: Record<string, unknown> }> = [];
    const tracer = {
      span: async (
        descriptor: { op: string; name: string; attributes?: Record<string, unknown> },
        callback: (span: { setAttributes(a: Record<string, unknown>): void }) => Promise<unknown>,
      ) => {
        const entry = {
          op: descriptor.op,
          name: descriptor.name,
          attributes: { ...(descriptor.attributes ?? {}) },
        };
        recorded.push(entry);
        return callback({
          setAttributes: (attributes) => Object.assign(entry.attributes, attributes),
        });
      },
    };
    const fixture = await createFixture();
    fixture.options.maxIncidents = 2;

    await createOrchestrator(fixture).analyze(fixture.options, {
      tracer: tracer as never,
    });

    expect(recorded.length).toBeGreaterThanOrEqual(3);
    const ops = new Set<string>(ANALYSIS_SPAN_OPS);
    const names = new Set<string>(ANALYSIS_SPAN_NAMES);
    for (const span of recorded) {
      expect(ops.has(span.op)).toBe(true);
      expect(names.has(span.name)).toBe(true);
      for (const [key, value] of Object.entries(span.attributes)) {
        expect(isSafeTraceAttribute(key, value)).toBe(true);
      }
    }
    const publish = recorded.find((span) => span.name === "stage publish");
    expect(publish?.attributes["frame_of_mind.outcome"]).toBe("complete");
    expect(recorded.some((span) => span.name === "gemini interrogate")).toBe(true);
    expect(recorded.some((span) => span.name === "gemini index")).toBe(true);
    expect(recorded.some((span) => span.name === "stage upload")).toBe(true);
  });

  it("attaches token deltas and failure codes to failed provider spans", async () => {
    const recorded: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const tracer = {
      span: async (
        descriptor: { op: string; name: string; attributes?: Record<string, unknown> },
        callback: (span: { setAttributes(a: Record<string, unknown>): void }) => Promise<unknown>,
      ) => {
        const entry = { name: descriptor.name, attributes: { ...(descriptor.attributes ?? {}) } };
        recorded.push(entry);
        return callback({
          setAttributes: (attributes) => Object.assign(entry.attributes, attributes),
        });
      },
    };
    const fixture = await createFixture();
    fixture.options.maxIncidents = 2;
    // Simulated provider usage: every interrogation consumes tokens whether
    // or not it validates, exactly like the real adapter's recordUsage.
    let consumedPromptTokens = 0;
    (fixture.analyzer as unknown as {
      usageSnapshot(): { promptTokens: number; outputTokens: number; totalTokens: number };
    }).usageSnapshot = () => ({
      promptTokens: consumedPromptTokens,
      outputTokens: consumedPromptTokens,
      totalTokens: consumedPromptTokens * 2,
    });
    fixture.analyzer.index = vi.fn(async () => ({
      ...indexResult(),
      moments: [1, 2].map((second) => ({
        ...indexResult().moments[0]!,
        start: `00:00:0${second}`,
        end: `00:00:0${second + 1}`,
      })),
    }));
    fixture.analyzer.interrogate = vi.fn(async (_file, candidate) => {
      consumedPromptTokens += 100;
      if (candidate.start === "00:00:01") {
        throw new CandidateAnalysisError({ code: "invalid_json", attempts: 2 });
      }
      return {
        ...detailResult(),
        accepted: true,
        evidence: { timestamp: candidate.start },
      };
    });

    await createOrchestrator(fixture).analyze(fixture.options, { tracer: tracer as never });

    const interrogations = recorded.filter((span) => span.name === "gemini interrogate");
    expect(interrogations).toHaveLength(2);
    const [failed, succeeded] = interrogations;
    // The failed call's billable tokens stay queryable, with its code.
    expect(failed?.attributes["frame_of_mind.candidate_failure_code"]).toBe("invalid_json");
    expect(failed?.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(failed?.attributes["frame_of_mind.candidate_accepted"]).toBeUndefined();
    // The next candidate's delta is not cross-contaminated by the failure.
    expect(succeeded?.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(succeeded?.attributes["frame_of_mind.candidate_accepted"]).toBe(true);
  });

  it("publishes a failed sanitized outcome and cleanup receipt when every detail fails", async () => {
    const fixture = await createFixture();
    fixture.analyzer.interrogate = vi.fn(async () => {
      throw new CandidateAnalysisError({
        code: "invalid_json",
        attempts: 2,
      });
    });

    const result = await createOrchestrator(fixture).analyze(fixture.options);

    expect(result.analysis.items).toEqual([]);
    expect(result.outcome).toMatchObject({
      status: "failed",
      candidates: {
        indexed: 1,
        selected: 1,
        omittedByLimit: 0,
        validated: 0,
        accepted: 0,
        rejected: 0,
        failed: 1,
      },
      failures: [{ code: "invalid_json", attempts: 2 }],
    });
    expect(result.manifest.remoteFile?.deleted).toBe(true);
    await expect(stat(join(result.directory, "manifest.json"))).resolves.toBeDefined();
    await expect(stat(join(result.directory, "analysis-outcome.json"))).resolves.toBeDefined();
  });

  it("freezes cleanup provenance at publication and warns when deletion fails", async () => {
    const fixture = await createFixture();
    fixture.analyzer.delete = vi.fn(async () => {
      throw new Error("remote provider body");
    });
    const events: AnalysisProgressEvent[] = [];

    const result = await createOrchestrator(fixture).analyze(fixture.options, {
      progress: { report: (event) => events.push(event) },
    });

    expect(fixture.analyzer.delete).toHaveBeenCalledTimes(3);
    expect(result.manifest.remoteFile?.deleted).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "warning",
      message: "Gemini file cleanup failed; manifest records deleted=false.",
    });
    const persistedManifest = JSON.parse(
      await readFile(join(result.directory, "manifest.json"), "utf8"),
    );
    expect(persistedManifest.remoteFile.deleted).toBe(false);
  });

  it("reuses a retained Gemini upload without uploading or deleting", async () => {
    const fixture = await createFixture();
    const retained: GeminiFile = {
      name: "files/retained-test",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/retained-test",
      mimeType: "video/mp4",
      state: "ACTIVE",
    };
    const resolveRetainedFile = vi.fn(async () => retained);
    const analyzer = { ...fixture.analyzer, resolveRetainedFile };
    const events: AnalysisProgressEvent[] = [];
    const orchestrator = new AnalysisOrchestrator({
      createContextSource: () => fixture.context,
      createAnalyzer: () => analyzer,
      createRunId: () => "reuse-run",
      now: () => "2026-07-27T12:00:00.000Z",
      sleep: async () => undefined,
    });

    const result = await orchestrator.analyze({
      contextMode: "none",
      recipe: fixture.options.recipe,
      customRecipe: fixture.options.customRecipe,
      recipeSha256: fixture.options.recipeSha256,
      recipeRevision: fixture.options.recipeRevision,
      apiKey: fixture.options.apiKey,
      video: fixture.options.video!,
      outputRoot: fixture.outputRoot,
      maxIncidents: fixture.options.maxIncidents,
      screenshots: false,
      keepUpload: false,
      remoteFileName: "files/retained-test",
    }, {
      progress: { report: (event) => events.push(event) },
    });

    expect(analyzer.upload).not.toHaveBeenCalled();
    expect(analyzer.delete).not.toHaveBeenCalled();
    expect(resolveRetainedFile).toHaveBeenCalledWith(
      "files/retained-test",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Number),
    );
    expect(result.manifest.remoteFile).toMatchObject({
      name: "files/retained-test",
      deleted: false,
    });
    expect(events.some((event) =>
      event.kind === "stage"
        && event.message === "Reusing the retained Gemini upload…",
    )).toBe(true);
  });

  it("aborts as systematic when the leading candidates all fail at generation", async () => {
    const fixture = await createFixture();
    const index = indexResult();
    fixture.analyzer.index = vi.fn(async () => ({
      ...index,
      moments: [
        { ...index.moments[0]!, start: "00:00:01", end: "00:00:05" },
        { ...index.moments[0]!, start: "00:00:06", end: "00:00:10" },
        { ...index.moments[0]!, start: "00:00:11", end: "00:00:15" },
        { ...index.moments[0]!, start: "00:00:16", end: "00:00:20" },
      ],
    }));
    fixture.analyzer.interrogate = vi.fn(async () => {
      throw new CandidateAnalysisError({ code: "generation_failed", attempts: 1 });
    });
    fixture.options.maxIncidents = 4;

    await expect(createOrchestrator(fixture).analyze(fixture.options))
      .rejects.toThrow("aborting as a systematic failure");
    expect(fixture.analyzer.interrogate).toHaveBeenCalledTimes(3);
    const container = join(fixture.outputRoot, "meeting-test");
    const runs = await readdir(container);
    expect(runs).toContain("run-test");
    const failureManifest = JSON.parse(
      await readFile(join(container, "run-test", "failure-manifest.json"), "utf8"),
    );
    expect(failureManifest).toMatchObject({ status: "failed", phase: "detail" });
  });

  it("commits overlapping detail calls in candidate order identical to a sequential run", async () => {
    async function run(detailConcurrency: number) {
      const fixture = await createFixture();
      const index = indexResult();
      fixture.options.maxIncidents = 6;
      fixture.options.screenshots = true;
      fixture.options.detailConcurrency = detailConcurrency;
      fixture.analyzer.index = vi.fn(async () => ({
        ...index,
        moments: [1, 2, 3, 4, 5, 6, 7].map((second) => ({
          ...index.moments[0]!,
          start: `00:00:0${second}`,
          end: `00:00:0${second + 1}`,
        })),
      }));
      let inFlight = 0;
      let maxInFlight = 0;
      fixture.analyzer.interrogate = vi.fn(async (_file, candidate: IndexedMoment) => {
        const second = Number(candidate.start.slice(-1));
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          // Earlier candidates finish later so completion order is reversed.
          await new Promise((resolve) => setTimeout(resolve, (8 - second) * 3));
          if (second === 2) {
            throw new CandidateAnalysisError({ code: "schema_validation", attempts: 2 });
          }
          return {
            ...detailResult(),
            title: `Moment ${second}`,
            accepted: second !== 4,
            evidence: { timestamp: candidate.start },
          };
        } finally {
          inFlight -= 1;
        }
      });
      const screenshots: string[] = [];
      const events: AnalysisProgressEvent[] = [];
      const orchestrator = new AnalysisOrchestrator({
        createContextSource: () => fixture.context,
        createAnalyzer: () => fixture.analyzer,
        createRunId: () => "run-test",
        now: () => "2026-07-27T12:00:00.000Z",
        sleep: async () => undefined,
        extractScreenshot: vi.fn(async (_video: string, timestamp: string, destination: string) => {
          screenshots.push(`${timestamp}->${destination.split("/").pop()}`);
          await writeFile(destination, "png");
          return true;
        }),
      });
      const result = await orchestrator.analyze(fixture.options, {
        progress: { report: (event) => events.push(event) },
      });
      return { result, events, screenshots, maxInFlight };
    }

    const sequential = await run(1);
    const concurrent = await run(3);

    expect(sequential.maxInFlight).toBe(1);
    expect(concurrent.maxInFlight).toBe(3);
    expect(concurrent.result.analysis.items).toEqual(sequential.result.analysis.items);
    expect(concurrent.result.outcome).toEqual(sequential.result.outcome);
    expect(concurrent.screenshots).toEqual(sequential.screenshots);
    expect(concurrent.events).toEqual(sequential.events);
    expect(sequential.result.analysis.items.map((item) => item.result.title)).toEqual([
      "Moment 1", "Moment 3", "Moment 4", "Moment 5", "Moment 6",
    ]);
    expect(sequential.result.outcome.candidates).toMatchObject({
      indexed: 7, selected: 6, omittedByLimit: 1, failed: 1, accepted: 4, rejected: 1,
    });
    const completed = concurrent.events.flatMap((event) =>
      event.kind === "progress" && event.stage === "interrogating" ? [event.progress.completed] : []);
    expect(completed).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects an out-of-range detail concurrency before any provider work", async () => {
    const fixture = await createFixture();
    for (const detailConcurrency of [0, 9, 1.5]) {
      await expect(createOrchestrator(fixture).analyze({ ...fixture.options, detailConcurrency }))
        .rejects.toThrow("Detail concurrency must be an integer from 1 to 8.");
    }
    expect(fixture.context.connect).not.toHaveBeenCalled();
    expect(fixture.analyzer.upload).not.toHaveBeenCalled();
  });

  it("starts no new detail call after cancellation while overlapping calls settle", async () => {
    const fixture = await createFixture();
    const index = indexResult();
    fixture.options.maxIncidents = 6;
    fixture.options.detailConcurrency = 2;
    fixture.analyzer.index = vi.fn(async () => ({
      ...index,
      moments: [1, 2, 3, 4, 5, 6].map((second) => ({
        ...index.moments[0]!,
        start: `00:00:0${second}`,
        end: `00:00:0${second + 1}`,
      })),
    }));
    const controller = new AbortController();
    fixture.analyzer.interrogate = vi.fn(async (_file, candidate: IndexedMoment) => {
      if (candidate.start === "00:00:02") controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...detailResult(), evidence: { timestamp: candidate.start } };
    });

    await expect(createOrchestrator(fixture).analyze(fixture.options, { signal: controller.signal }))
      .rejects.toBeInstanceOf(AnalysisCanceledError);
    expect(fixture.analyzer.interrogate).toHaveBeenCalledTimes(2);
    expect(fixture.analyzer.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps isolating generation failures that are not systematic", async () => {
    const fixture = await createFixture();
    const index = indexResult();
    fixture.analyzer.index = vi.fn(async () => ({
      ...index,
      moments: [
        { ...index.moments[0]!, start: "00:00:01", end: "00:00:05" },
        { ...index.moments[0]!, start: "00:00:06", end: "00:00:10" },
      ],
    }));
    let call = 0;
    const detail = detailResult();
    fixture.analyzer.interrogate = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        throw new CandidateAnalysisError({ code: "generation_failed", attempts: 1 });
      }
      return detail;
    });
    fixture.options.maxIncidents = 2;

    const result = await createOrchestrator(fixture).analyze(fixture.options);

    expect(result.outcome).toMatchObject({
      status: "partial",
      candidates: { accepted: 1, failed: 1 },
      failures: [{ code: "generation_failed", attempts: 1 }],
    });
  });
});

interface Fixture {
  meeting: MeetingEvidence;
  context: MeetingContextSource;
  analyzer: AnalysisVideoAnalyzer & {
    upload: ReturnType<typeof vi.fn>;
    index: ReturnType<typeof vi.fn>;
    interrogate: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  options: Parameters<AnalysisOrchestrator["analyze"]>[0];
  outputRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(
    join(tmpdir(), "frame-of-mind-orchestrator-test-"),
  );
  temporaryDirectories.push(root);
  const video = join(root, "recording.mp4");
  await writeFile(video, "synthetic-video");
  const outputRoot = join(root, "runs");
  const meeting: MeetingEvidence = {
    id: "meeting-test",
    provider: "file",
    transport: "file",
    title: "Test meeting",
    transcript: "[00:00:01] Brandon: Please add the report.",
    raw: {},
  };
  const context: MeetingContextSource = {
    provider: "file",
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    meeting: vi.fn(async () => meeting),
  };
  const remote: GeminiFile = {
    name: "files/test",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/test",
    mimeType: "video/mp4",
    state: "ACTIVE",
  };
  const analyzer = {
    model: "gemini-test",
    upload: vi.fn(async () => remote),
    index: vi.fn(async () => indexResult()),
    interrogate: vi.fn(async () => detailResult()),
    delete: vi.fn(async () => undefined),
  };
  const recipe: AnalysisRecipe = {
    id: "requirements",
    label: "Requirements",
    description: "Find requirements.",
    indexInstruction: "Index requirements.",
    interrogationInstruction: "Verify requirements.",
  };
  return {
    meeting,
    context,
    analyzer,
    outputRoot,
    options: {
      meetingId: meeting.id,
      recipe,
      customRecipe: false,
      recipeSha256: "a".repeat(64),
      recipeRevision: "test",
      contextProvider: "file",
      granolaTransport: "mcp",
      contextFile: join(root, "context.json"),
      apiKey: "test-key",
      video,
      outputRoot,
      maxIncidents: 1,
      screenshots: false,
      keepUpload: false,
    },
  };
}

function createOrchestrator(fixture: Fixture): AnalysisOrchestrator {
  return new AnalysisOrchestrator({
    createContextSource: () => fixture.context,
    createAnalyzer: () => fixture.analyzer,
    createRunId: () => "run-test",
    now: () => "2026-07-27T12:00:00.000Z",
    sleep: async () => undefined,
  });
}

function indexResult() {
  const moment: IndexedMoment = {
    start: "00:00:01",
    end: "00:00:05",
    speaker: "Brandon",
    surface: "Reporting",
    summary: "Requested a report change.",
    kind: "requirement",
    importance: "high",
  };
  return {
    isRelevantCall: true,
    matchNotes: "Matched.",
    transcriptAlignment: {
      offsetSeconds: 0,
      confidence: "high" as const,
      rationale: "Aligned.",
    },
    moments: [moment],
  };
}

function detailResult(): AnalysisDetail {
  return {
    accepted: true,
    kind: "requirement",
    title: "Add the requested report",
    summary: "A report change was requested.",
    evidence: {
      timestamp: "00:00:03",
      reporterQuote: "Please add the report.",
      speaker: "Brandon",
    },
    importance: "high",
  };
}

describe("retention", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("with no flag or env the upload is not deleted and remoteFile.deleted is false", async () => {
    const { buildAnalyzeOptions, printAnalysisSummary } = await import("../src/cli.js");
    vi.stubEnv("FRAME_OF_MIND_UPLOAD_RETENTION", undefined);
    const fixture = await createFixture();
    const options = await buildAnalyzeOptions(undefined, {
      source: "none", granolaTransport: "mcp", recipe: "requirements", depth: "standard",
      video: fixture.options.video, output: fixture.outputRoot, maxMoments: "10",
      screenshots: false, derivedTranscript: false,
    }, "synthetic-key");
    fixture.analyzer.upload.mockResolvedValue({ name: "files/test", uri: "https://generativelanguage.googleapis.com/v1beta/files/test", state: "ACTIVE", expirationTime: "2026-11-15T09:12:00Z" });
    const result = await createOrchestrator(fixture).analyze(options);
    expect(fixture.analyzer.delete, "zero expected deleteFile calls").toHaveBeenCalledTimes(0);
    expect(result.manifest.remoteFile?.deleted).toBe(false);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      printAnalysisSummary(result);
      const output = stdout.mock.calls.map(([s]) => s).join("");
      expect(output).toContain("provider expiration 2026-11-15T09:12:00Z");
      expect(output).toContain("per-file limit 2 GB");
      delete result.manifest.remoteFile!.expirationTime;
      stdout.mockClear();
      printAnalysisSummary(result);
      expect(stdout.mock.calls.map(([s]) => s).join("")).toContain("expiration not reported");
    } finally { stdout.mockRestore(); }
  });

  it("--retention run deletes the upload once on success and on failure", async () => {
    for (const fails of [false, true]) {
      const fixture = await createFixture();
      fixture.options.retention = "run";
      fixture.options.keepUpload = true; // resolved policy wins over legacy input
      if (fails) fixture.analyzer.index.mockRejectedValue(new Error("synthetic failure"));
      const run = createOrchestrator(fixture).analyze(fixture.options);
      if (fails) await expect(run).rejects.toThrow("synthetic failure");
      else expect((await run).manifest.remoteFile?.deleted).toBe(true);
      expect(fixture.analyzer.delete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "files/test" }));
    }
  });

  it("provider retention also keeps an upload after analysis failure", async () => {
    const fixture = await createFixture();
    fixture.options.retention = "provider";
    fixture.analyzer.index.mockRejectedValue(new Error("synthetic failure"));
    await expect(createOrchestrator(fixture).analyze(fixture.options)).rejects.toThrow();
    expect(fixture.analyzer.delete).not.toHaveBeenCalled();
  });
});

describe("best-N selection", () => {
  it("interrogates the best 10 of 57 in time order and reports lower-importance banners", async () => {
    const fixture = await createFixture(); fixture.options.maxIncidents = 10;
    const moments = Array.from({ length: 57 }, (_, i) => ({ ...indexResult().moments[0]!,
      start: `00:00:${String(i).padStart(2, "0")}`, end: `00:00:${String(i + 1).padStart(2, "0")}`,
      importance: (i >= 50 ? "high" : i >= 20 ? "medium" : "low") as "high" | "medium" | "low",
    }));
    fixture.analyzer.index.mockResolvedValue({ ...indexResult(), moments });
    fixture.analyzer.interrogate.mockImplementation(async (_file, candidate) => ({ ...detailResult(), evidence: { timestamp: candidate.start } }));
    const result = await createOrchestrator(fixture).analyze(fixture.options);
    expect(result.analysis.items.map(item => item.candidate.start)).toEqual([20,21,22,50,51,52,53,54,55,56].map(i => `00:00:${i}`));
    expect(result.outcome.candidates).toMatchObject({ indexed: 57, selected: 10, omittedByLimit: 47 });
    expect(result.manifest.analysis.selection).toBe("best-importance");
    for (const file of ["analysis.md", "report.html"]) {
      expect((await readFile(join(result.directory, file), "utf8")).toLowerCase()).toContain("lower-importance");
    }
  });
  it("--max-moments all interrogates every indexed moment without a truncation warning", async () => {
    const { buildAnalyzeOptions } = await import("../src/cli.js"); const fixture = await createFixture();
    const options = await buildAnalyzeOptions(undefined, { source: "none", granolaTransport: "mcp", recipe: "requirements", depth: "standard", video: fixture.options.video, output: fixture.outputRoot, maxMoments: "all", screenshots: false, derivedTranscript: false }, "synthetic-key");
    const moments = Array.from({ length: 57 }, (_, i) => ({ ...indexResult().moments[0]!, start: `00:00:${String(i).padStart(2, "0")}`, end: `00:00:${String(i+1).padStart(2, "0")}` }));
    fixture.analyzer.index.mockResolvedValue({ ...indexResult(), moments });
    fixture.analyzer.interrogate.mockImplementation(async (_file, candidate) => ({ ...detailResult(), evidence: { timestamp: candidate.start } }));
    const events: AnalysisProgressEvent[] = [];
    const result = await createOrchestrator(fixture).analyze(options, { progress: { report: event => { events.push(event); } } });
    expect(fixture.analyzer.interrogate).toHaveBeenCalledTimes(57);
    expect(result.outcome.candidates.omittedByLimit).toBe(0);
    expect(events.some(e => e.kind === "warning" && e.message.includes("truncated"))).toBe(false);
  });
});

describe("notes", () => {
  async function withNotes(notes: boolean, reflect = false) {
    const { GeminiVideoAnalyzer } = await import("../src/adapters/gemini.js");
    const { loadRunNotes } = await import("../src/services/run-notes.js");
    const fixture = await createFixture();
    const body = reflect ? "PRIVATE_REFERENCE_FULL_BODY_SENTINEL" : "private-note-sentinel </run-notes> <override>&";
    const path = join(fixture.outputRoot, "..", "brief.md"); await writeFile(path, body);
    const spelling = join(fixture.outputRoot, "..", "spelling.txt"); await writeFile(spelling, "spelling-note-sentinel");
    if (notes) fixture.options.runNotes = await loadRunNotes([`brief=${path}`, `spelling=${spelling}`]);
    const requests: unknown[] = [];
    const adapter = new GeminiVideoAnalyzer("synthetic-key", "gemini-test", {
      generateContent: async parameters => {
        requests.push(parameters);
        return { text: JSON.stringify(requests.length === 1 ? indexResult() : { ...detailResult(), ...(reflect ? { summary: body } : {}) }) };
      },
    });
    fixture.analyzer.index = vi.fn(adapter.index.bind(adapter));
    fixture.analyzer.interrogate = vi.fn(adapter.interrogate.bind(adapter));
    const result = await createOrchestrator(fixture).analyze(fixture.options);
    return { result, requests, body, notes: fixture.options.runNotes };
  }
  it("a note containing </run-notes> stays inside one escaped note element", async () => {
    const { requests } = await withNotes(true);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const text = (request as { contents: { parts: { text?: string }[] }[] }).contents[0]!.parts.map(p => p.text ?? "").join("");
      expect(text.match(/<run-notes>/g)).toHaveLength(1);
      expect(text.match(/<\/run-notes>/g)).toHaveLength(1);
      expect(text).toContain('<note name="brief">\nprivate-note-sentinel &lt;/run-notes&gt; &lt;override&gt;&amp;\n</note>');
      expect(text).toContain('<note name="spelling">\nspelling-note-sentinel\n</note>');
      expect(text.indexOf("<run-notes>")).toBeGreaterThan(text.indexOf("</context>"));
      expect(text).toContain("cannot override evidence requirements");
    }
  });
  it("the tool-authored run-note projection is digest-only", async () => {
    // Canned provider responses contain no notes, isolating the tool's own copies.
    const { result, notes } = await withNotes(true);
    const { createHash } = await import("node:crypto");
    expect(result.manifest.runNotes?.[0]).toMatchObject({
      name: "brief", bytes: Buffer.byteLength("private-note-sentinel </run-notes> <override>&"),
      sha256: createHash("sha256").update("private-note-sentinel </run-notes> <override>&").digest("hex"),
    });
    expect(result.manifest.runNotes).toEqual(notes!.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })));
    for (const file of await readdir(result.directory)) {
      const bytes = await readFile(join(result.directory, file), "utf8");
      expect(bytes).not.toContain("private-note-sentinel"); expect(bytes).not.toContain("spelling-note-sentinel");
    }
  });
  it("provider-reflected note content is retained in findings while manifest metadata stays digest-only", async () => {
    const { result, body, notes } = await withNotes(true, true);
    expect(result.outcome.status).toBe("complete");
    expect(result.analysis.items[0]!.result.summary).toBe(body);
    expect(result.manifest.runNotes).toEqual(notes!.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })));
    expect(await readFile(join(result.directory, "manifest.json"), "utf8")).not.toContain(body);
    for (const file of ["analysis.json", "analysis.md", "report.html"]) {
      expect(await readFile(join(result.directory, file), "utf8"), file).toContain(body);
    }
  });
  it("promptPrefix digests are identical with and without notes", async () => {
    const baseline = await withNotes(false); const noted = await withNotes(true);
    expect(noted.result.manifest.promptProvenance).toEqual(baseline.result.manifest.promptProvenance);
  });
});

describe("concurrency", () => {
  it("all-failing detail calls at 6 stop within 3 + 6 - 1 interrogate calls", async () => {
    const fixture = await createFixture();
    fixture.options.maxIncidents = 20;
    fixture.options.detailConcurrency = 6;
    fixture.analyzer.index.mockResolvedValue({
      ...indexResult(),
      moments: Array.from({ length: 20 }, (_, i) => ({
        ...indexResult().moments[0]!,
        start: `00:00:${String(i + 1).padStart(2, "0")}`,
        end: `00:00:${String(i + 2).padStart(2, "0")}`,
      })),
    });
    // The first request is slow while later requests fail immediately. A spend
    // bound must also hold when completions are out of order, not just in sync.
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    let calls = 0;
    let release: ReturnType<typeof setTimeout> | undefined;
    fixture.analyzer.interrogate.mockImplementation(async (_file, candidate: IndexedMoment) => {
      calls += 1;
      if (calls === 20) releaseFirst();
      if (candidate.start === "00:00:01") {
        release = setTimeout(releaseFirst, 25);
        await first;
      }
      throw new CandidateAnalysisError({ code: "generation_failed", attempts: 1 });
    });
    // Release the held call even if dispatch correctly stops before all 20.
    try {
      await expect(createOrchestrator(fixture).analyze(fixture.options))
        .rejects.toThrow("aborting as a systematic failure");
    } finally { if (release) clearTimeout(release); releaseFirst(); }
    expect(calls, "interrogate calls must be bounded by 3 + 6 - 1").toBeLessThanOrEqual(8);
    console.log(`P3 calls=${calls} extra_calls_vs_sequential=${calls - 3} bound=8`);
  });
});

describe("concurrency", () => {
  async function parallelFixture(limit: number, count = 12) {
    const fixture = await createFixture();
    fixture.options.detailConcurrency = limit;
    fixture.options.maxIncidents = count;
    fixture.analyzer.index.mockResolvedValue({ ...indexResult(), moments: Array.from({ length: count }, (_, i) => ({
      ...indexResult().moments[0]!, start: `00:00:${String(i + 1).padStart(2, "0")}`,
      end: `00:00:${String(i + 2).padStart(2, "0")}`,
    })) });
    return fixture;
  }

  it.each(["success", "schema_validation"])("resumes after three out-of-order generation failures when the earlier call is %s", async (first) => {
    async function run(limit: number) {
      const fixture = await parallelFixture(limit);
      fixture.analyzer.interrogate.mockImplementation(async (_file, candidate) => {
        const ordinal = Number(candidate.start.slice(-2));
        if (ordinal === 1) {
          await new Promise(resolve => setTimeout(resolve, 25));
          if (first === "schema_validation") throw new CandidateAnalysisError({ code: first, attempts: 2 });
        } else if (ordinal <= 4) throw new CandidateAnalysisError({ code: "generation_failed", attempts: 1 });
        return { ...detailResult(), evidence: { timestamp: candidate.start } };
      });
      const result = await createOrchestrator(fixture).analyze(fixture.options);
      expect(fixture.analyzer.interrogate).toHaveBeenCalledTimes(12);
      return result;
    }
    const sequential = await run(1); const parallel = await run(6);
    expect(parallel.analysis.items).toEqual(sequential.analysis.items);
    expect(parallel.outcome).toEqual(sequential.outcome);
  });

  it("best-N detail results and bundle content stay in chronological order at 1 and 6", async () => {
    async function run(limit: number) {
      const fixture = await parallelFixture(limit);
      fixture.options.maxIncidents = 6;
      const index = await fixture.analyzer.index();
      index.moments.forEach((moment, i) => { moment.importance = i % 2 ? "high" : "low"; });
      fixture.analyzer.interrogate.mockImplementation(async (_file, candidate) => {
        await new Promise(resolve => setTimeout(resolve, 13 - Number(candidate.start.slice(-2))));
        return { ...detailResult(), evidence: { timestamp: candidate.start } };
      });
      return createOrchestrator(fixture).analyze(fixture.options);
    }
    const sequential = await run(1); const parallel = await run(6);
    expect(parallel.analysis.items.map(item => item.candidate.start)).toEqual([2,4,6,8,10,12].map(i => `00:00:${String(i).padStart(2, "0")}`));
    expect(parallel.outcome).toEqual(sequential.outcome);
    for (const name of await readdir(sequential.directory)) {
      expect(await readFile(join(parallel.directory, name), "utf8"), name).toBe(await readFile(join(sequential.directory, name), "utf8"));
    }
  });

  it("429 at concurrency 6 exhausts only existing retries within the fake clock bound", async () => {
    const { GeminiVideoAnalyzer } = await import("../src/adapters/gemini.js");
    const { GEMINI_GENERATION_TRANSPORT_RETRIES } = await import("../src/adapters/gemini-generation-policy.js");
    const fixture = await parallelFixture(6, 20);
    const calls: Array<{ attempts: number; waits: number[] }> = [];
    fixture.analyzer.interrogate.mockImplementation(async (...args) => {
      const call = { attempts: 0, waits: [] as number[] }; calls.push(call);
      const adapter = new GeminiVideoAnalyzer("synthetic-key", "gemini-test", {
        // Gemini API troubleshooting documents 429 RESOURCE_EXHAUSTED:
        // https://ai.google.dev/gemini-api/docs/troubleshooting
        generateContent: async () => { call.attempts += 1; throw { status: 429, message: "RESOURCE_EXHAUSTED" }; },
        sleep: async milliseconds => { call.waits.push(milliseconds); },
      });
      return adapter.interrogate(...args);
    });
    await expect(createOrchestrator(fixture).analyze(fixture.options)).rejects.toThrow("aborting as a systematic failure");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(8);
    for (const call of calls) {
      expect(call.attempts).toBe(1 + GEMINI_GENERATION_TRANSPORT_RETRIES);
      expect(call.waits).toEqual([1000, 2000, 4000, 8000]);
      expect(call.waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(15000);
    }
    console.log(`P4 calls=${calls.length} transport_attempts=${calls.reduce((n, c) => n + c.attempts, 0)} extra_calls_vs_sequential=${calls.length - 3} per_call_fake_wait_ms=15000`);
  });

  it("429 responses recovered by retries never count as breaker failures", async () => {
    const { GeminiVideoAnalyzer } = await import("../src/adapters/gemini.js");
    const fixture = await parallelFixture(6);
    const attempts: number[] = [];
    fixture.analyzer.interrogate.mockImplementation(async (...args) => {
      const id = attempts.length; attempts.push(0);
      const adapter = new GeminiVideoAnalyzer("synthetic-key", "gemini-test", {
        generateContent: async () => {
          attempts[id]! += 1;
          if (attempts[id]! <= 4) throw { status: 429, message: "RESOURCE_EXHAUSTED" };
          return { text: JSON.stringify({ ...detailResult(), evidence: { timestamp: args[1].start } }) };
        }, sleep: async () => undefined,
      });
      return adapter.interrogate(...args);
    });
    const result = await createOrchestrator(fixture).analyze(fixture.options);
    expect(attempts).toEqual(Array(12).fill(5));
    expect(result.outcome.candidates.failed).toBe(0);
    expect(result.analysis.items).toHaveLength(12);
  });

  it("per-span token attributes are omitted above 1", async () => {
    const fixture = await parallelFixture(6);
    let tokens = 0;
    Object.assign(fixture.analyzer, { usageSnapshot: () => ({ promptTokens: tokens, outputTokens: tokens, totalTokens: tokens * 2 }) });
    fixture.analyzer.interrogate.mockImplementation(async (_file, candidate) => {
      tokens += 100;
      return { ...detailResult(), evidence: { timestamp: candidate.start } };
    });
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const tracer = { span: async (
      descriptor: { name: string; attributes?: Record<string, unknown> },
      callback: (span: { setAttributes(a: Record<string, unknown>): void }) => Promise<unknown>,
    ) => {
      const span = { name: descriptor.name, attributes: { ...descriptor.attributes } }; spans.push(span);
      return callback({ setAttributes: attrs => { Object.assign(span.attributes, attrs); } });
    } };
    await createOrchestrator(fixture).analyze(fixture.options, { tracer: tracer as never });
    const details = spans.filter(span => span.name === "gemini interrogate");
    expect(details).toHaveLength(12);
    for (const span of details) expect(Object.keys(span.attributes).filter(key => key.startsWith("gen_ai.usage."))).toEqual([]);
  });

  it("records wall clock for twelve 200 ms details at 1 and 6", async () => {
    const elapsed: number[] = [];
    for (const limit of [1, 6]) {
      const fixture = await parallelFixture(limit);
      fixture.analyzer.interrogate.mockImplementation(async (_file, candidate) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { ...detailResult(), evidence: { timestamp: candidate.start } };
      });
      const start = performance.now();
      const result = await createOrchestrator(fixture).analyze(fixture.options);
      elapsed.push(Math.round(performance.now() - start));
      expect(result.analysis.items).toHaveLength(12);
    }
    console.log(`P8 fake_200ms_details=12 concurrency_1_ms=${elapsed[0]} concurrency_6_ms=${elapsed[1]}`);
  });
});
