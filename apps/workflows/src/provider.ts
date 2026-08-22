import type { File as GeminiFile } from "@google/genai";
import { GeminiVideoAnalyzer } from "../../../src/adapters/gemini.js";
import type {
  AnalysisDetail,
  AnalysisRecipe,
  DerivedTranscriptionSegment,
  IndexedMoment,
  MeetingContextSource,
  MeetingEvidence,
} from "../../../src/domain/types.js";
import {
  formatDerivedTranscript,
  nearbyTranscript,
} from "../../../src/services/transcript.js";
import type {
  HostedAnalysisAttempt,
  SealedHostedMediaReceipt,
} from "./contracts.js";

export interface HostedResolvedFile {
  name: string;
  uri: string;
  mimeType: string;
}

export interface HostedTranscriptResult {
  origin: "provider" | "operator" | "gemini-audio" | "none";
  text?: string;
  alignmentOffsetSeconds?: number;
}

export interface HostedAnalysisProvider {
  fetchContext(attempt: HostedAnalysisAttempt): Promise<MeetingEvidence | undefined>;
  ensureGeminiFile(
    receipt: SealedHostedMediaReceipt,
  ): Promise<HostedResolvedFile>;
  transcribe(file: HostedResolvedFile): Promise<DerivedTranscriptionSegment[]>;
  index(input: {
    file: HostedResolvedFile;
    meeting?: MeetingEvidence;
    transcript: HostedTranscriptResult;
    recipe: AnalysisRecipe;
    focus?: string;
  }): Promise<{
    matchNotes: string;
    moments: IndexedMoment[];
    transcriptAlignment?: {
      offsetSeconds: number;
      confidence: "high" | "medium" | "low" | "none";
      rationale: string;
    };
  }>;
  interrogate(input: {
    file: HostedResolvedFile;
    candidate: IndexedMoment;
    transcript: HostedTranscriptResult;
    recipe: AnalysisRecipe;
    focus?: string;
  }): Promise<AnalysisDetail>;
  cleanup(
    file: HostedResolvedFile,
    receipt: SealedHostedMediaReceipt,
  ): Promise<void>;
}

export type HostedContextSourceFactory = (
  attempt: HostedAnalysisAttempt,
) => MeetingContextSource;

export interface HostedGeminiAnalyzer {
  resolveRetainedFile?(
    name: string,
    expectedSha256: string,
  ): Promise<GeminiFile>;
  transcribe?(file: GeminiFile): Promise<DerivedTranscriptionSegment[]>;
  index(
    file: GeminiFile,
    meeting: MeetingEvidence | undefined,
    recipe: AnalysisRecipe,
    focus: string | undefined,
    minConfidence: number,
    derivedTranscript: string | undefined,
  ): Promise<{
    matchNotes: string;
    moments: IndexedMoment[];
    transcriptAlignment?: {
      offsetSeconds: number;
      confidence: "high" | "medium" | "low" | "none";
      rationale: string;
    };
  }>;
  interrogate(
    file: GeminiFile,
    candidate: IndexedMoment,
    transcript: string | undefined,
    recipe: AnalysisRecipe,
    focus: string | undefined,
    transcriptIsDerived: boolean,
  ): Promise<AnalysisDetail>;
  delete(file: GeminiFile): Promise<void>;
}

export interface HostedProviderEnv {
  GEMINI_API_KEY?: string;
  HOSTED_FAKE_GEMINI?: string;
}

export function createHostedAnalysisProvider(
  env: HostedProviderEnv,
  options: { contextSource?: HostedContextSourceFactory } = {},
): HostedAnalysisProvider {
  if (env.HOSTED_FAKE_GEMINI === "true") {
    return new FakeHostedAnalysisProvider(options.contextSource);
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("gemini_secret_unavailable");
  return new GeminiHostedAnalysisProvider(
    new GeminiVideoAnalyzer(apiKey),
    options.contextSource,
  );
}

export function resolveHostedTranscript(input: {
  meeting?: MeetingEvidence;
  derivedSegments?: DerivedTranscriptionSegment[];
}): HostedTranscriptResult {
  const contextual = input.meeting?.transcript.trim();
  if (contextual) {
    return {
      origin: input.meeting?.provider === "file" ? "operator" : "provider",
      text: contextual,
    };
  }
  if (input.derivedSegments) {
    const text = formatDerivedTranscript(input.derivedSegments).trim();
    if (text) {
      return {
        origin: "gemini-audio",
        text,
        alignmentOffsetSeconds: 0,
      };
    }
  }
  return { origin: "none" };
}

export class GeminiHostedAnalysisProvider implements HostedAnalysisProvider {
  constructor(
    private readonly analyzer: HostedGeminiAnalyzer,
    private readonly contextSource?: HostedContextSourceFactory,
  ) {}

  async fetchContext(
    attempt: HostedAnalysisAttempt,
  ): Promise<MeetingEvidence | undefined> {
    if ("mode" in attempt.input.context) return undefined;
    if (!this.contextSource) throw new Error("hosted_context_adapter_unavailable");
    const source = this.contextSource(attempt);
    try {
      await source.connect();
      const context = attempt.input.context;
      const meetingId = "meetingId" in context
        ? context.meetingId
        : context.contextFileId;
      return await source.meeting(meetingId);
    } finally {
      await source.close();
    }
  }

  async ensureGeminiFile(
    receipt: SealedHostedMediaReceipt,
  ): Promise<HostedResolvedFile> {
    if (!this.analyzer.resolveRetainedFile) {
      throw new Error("hosted_gemini_file_resolution_unavailable");
    }
    const file = await this.analyzer.resolveRetainedFile(
      receipt.geminiFileName,
      receipt.sha256,
    );
    return resolvedFile(file, receipt);
  }

  async transcribe(
    file: HostedResolvedFile,
  ): Promise<DerivedTranscriptionSegment[]> {
    if (!this.analyzer.transcribe) {
      throw new Error("hosted_gemini_transcription_unavailable");
    }
    return await this.analyzer.transcribe(asGeminiFile(file));
  }

  async index(input: {
    file: HostedResolvedFile;
    meeting?: MeetingEvidence;
    transcript: HostedTranscriptResult;
    recipe: AnalysisRecipe;
    focus?: string;
  }): Promise<{
    matchNotes: string;
    moments: IndexedMoment[];
    transcriptAlignment?: {
      offsetSeconds: number;
      confidence: "high" | "medium" | "low" | "none";
      rationale: string;
    };
  }> {
    const result = await this.analyzer.index(
      asGeminiFile(input.file),
      input.meeting,
      input.recipe,
      input.focus,
      0.5,
      input.transcript.origin === "gemini-audio"
        ? input.transcript.text
        : undefined,
    );
    return result;
  }

  async interrogate(input: {
    file: HostedResolvedFile;
    candidate: IndexedMoment;
    transcript: HostedTranscriptResult;
    recipe: AnalysisRecipe;
    focus?: string;
  }): Promise<AnalysisDetail> {
    return await this.analyzer.interrogate(
      asGeminiFile(input.file),
      input.candidate,
      input.transcript.text
        ? nearbyTranscript(
            input.transcript.text,
            input.candidate.start,
            input.candidate.end,
            45,
            input.transcript.alignmentOffsetSeconds ?? 0,
          )
        : undefined,
      input.recipe,
      input.focus,
      input.transcript.origin === "gemini-audio",
    );
  }

  async cleanup(
    file: HostedResolvedFile,
    receipt: SealedHostedMediaReceipt,
  ): Promise<void> {
    if (receipt.retention === "retained") return;
    await this.analyzer.delete(asGeminiFile(file));
  }
}

class FakeHostedAnalysisProvider implements HostedAnalysisProvider {
  constructor(private readonly contextSource?: HostedContextSourceFactory) {}

  async fetchContext(
    attempt: HostedAnalysisAttempt,
  ): Promise<MeetingEvidence | undefined> {
    if ("mode" in attempt.input.context) return undefined;
    if (!this.contextSource) return undefined;
    const source = this.contextSource(attempt);
    try {
      await source.connect();
      const context = attempt.input.context;
      const id = "meetingId" in context ? context.meetingId : context.contextFileId;
      return await source.meeting(id);
    } finally {
      await source.close();
    }
  }

  async ensureGeminiFile(
    receipt: SealedHostedMediaReceipt,
  ): Promise<HostedResolvedFile> {
    return {
      name: receipt.geminiFileName,
      uri: receipt.geminiFileUri,
      mimeType: receipt.mimeType,
    };
  }

  async transcribe(): Promise<DerivedTranscriptionSegment[]> {
    return [{
      start: "00:00:00",
      end: "00:00:04",
      speaker: "Speaker 1",
      text: "A synthetic contract fixture requests a durable workflow.",
    }];
  }

  async index(): Promise<{ matchNotes: string; moments: IndexedMoment[] }> {
    return {
      matchNotes: "Synthetic hosted Workflow fixture matched the selected recording.",
      moments: [{
        start: "00:00:01",
        end: "00:00:03",
        summary: "The fixture demonstrates a durable hosted analysis step.",
        kind: "workflow-contract",
        importance: "high",
      }],
    };
  }

  async interrogate(input: {
    candidate: IndexedMoment;
  }): Promise<AnalysisDetail> {
    return {
      accepted: true,
      kind: input.candidate.kind,
      title: "Hosted Workflow contract",
      summary: "The synthetic Workflow reached an idempotent provider step.",
      evidence: { timestamp: "00:00:02" },
      importance: "high",
    };
  }

  async cleanup(): Promise<void> {}
}

function resolvedFile(
  file: GeminiFile,
  receipt: SealedHostedMediaReceipt,
): HostedResolvedFile {
  if (
    typeof file.name !== "string"
    || file.name !== receipt.geminiFileName
    || typeof file.uri !== "string"
    || file.uri !== receipt.geminiFileUri
  ) {
    throw new Error("sealed_media_receipt_provider_mismatch");
  }
  return {
    name: file.name,
    uri: file.uri,
    mimeType: file.mimeType ?? receipt.mimeType,
  };
}

function asGeminiFile(file: HostedResolvedFile): GeminiFile {
  return {
    name: file.name,
    uri: file.uri,
    mimeType: file.mimeType,
    state: "ACTIVE" as GeminiFile["state"],
  };
}
