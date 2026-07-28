import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("AnalysisOrchestrator", () => {
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
    );
    expect(fixture.analyzer.interrogate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      undefined,
      fixture.options.recipe,
      undefined,
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
    expect(result.projectionWarning).toBeUndefined();
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

  it("deletes the remote upload and empty meeting container after analysis failure", async () => {
    const fixture = await createFixture();
    fixture.analyzer.interrogate = vi.fn(async () => {
      throw new Error(
        "Gemini analysis response failed strict local validation at where.appUrl (custom).",
      );
    });

    await expect(
      createOrchestrator(fixture).analyze(fixture.options),
    ).rejects.toThrow("where.appUrl");

    expect(fixture.analyzer.delete).toHaveBeenCalledTimes(1);
    await expect(
      stat(join(fixture.outputRoot, fixture.meeting.id)),
    ).rejects.toThrow();
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
