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
