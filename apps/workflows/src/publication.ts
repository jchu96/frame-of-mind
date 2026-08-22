import { promptPrefix } from "../../../src/adapters/gemini.js";
import {
  analysisDigest,
  sha256Utf8,
  validateVersionedRunImport,
} from "../../../src/domain/integrity.js";
import type {
  AnalysisDetail,
  IndexedMoment,
  MeetingEvidence,
  VersionedAnalysisRun,
  VersionedRunManifest,
} from "../../../src/domain/types.js";
import type { VersionedRunImport } from "../../../src/domain/schemas.js";
import { builtInRecipe } from "../../../src/recipes/index.js";
import { createD1RunStore } from "../../web/server/data/d1-store.js";
import type { HostedAnalysisAttempt } from "./contracts.js";
import type {
  HostedResolvedFile,
  HostedTranscriptResult,
} from "./provider.js";

const HOSTED_TOOL_VERSION = "0.3.0";
const HOSTED_PROMPT_REVISION = "2026-08-11.1";

export interface HostedPublicationInput {
  attempt: HostedAnalysisAttempt;
  meeting?: MeetingEvidence;
  transcript: HostedTranscriptResult;
  transcriptAlignment?: {
    offsetSeconds: number;
    confidence: "high" | "medium" | "low" | "none";
    rationale: string;
  };
  matchNotes: string;
  moments: IndexedMoment[];
  details: AnalysisDetail[];
  file: HostedResolvedFile;
  cleanup: {
    deleted: boolean;
    completedAt: string;
  };
  publishedAt: string;
}

export async function buildHostedPublishedRun(
  input: HostedPublicationInput,
): Promise<VersionedRunImport> {
  if (input.moments.length !== input.details.length) {
    throw new Error("hosted_publication_item_count_mismatch");
  }
  const runId = `hosted_${input.attempt.attemptId}`;
  const recipe = {
    id: input.attempt.input.recipe.id,
    label: input.attempt.input.recipe.label,
  };
  const items = input.moments.map((candidate, index) => ({
    candidate,
    result: input.details[index]!,
  }));
  const analysis: VersionedAnalysisRun = "mode" in input.attempt.input.context
    ? {
        schemaVersion: 3,
        runId,
        recipe,
        context: { mode: "none" },
        model: input.attempt.input.model,
        matchNotes: input.matchNotes,
        items,
      }
    : buildMeetingAnalysis(input, runId, recipe, items);
  const analysisSha256 = await analysisDigest(analysis);
  const fullRecipe = builtInRecipe(input.attempt.input.recipe.id);
  const promptProvenance = {
    indexPrefixSha256: await sha256Utf8(
      promptPrefix(fullRecipe, "index"),
    ),
    interrogationPrefixSha256: await sha256Utf8(
      promptPrefix(fullRecipe, "detail"),
    ),
    modelRouting: {
      requestedModel: input.attempt.input.model,
      reason: "operator-selected" as const,
    },
  };
  const manifestBase = {
    toolVersion: HOSTED_TOOL_VERSION,
    promptRevision: HOSTED_PROMPT_REVISION,
    runId,
    startedAt: input.attempt.createdAt,
    completedAt: input.publishedAt,
    recipe: {
      ...recipe,
      custom: false,
      revision: input.attempt.input.recipe.revision,
      sha256: input.attempt.input.recipe.sha256,
    },
    model: input.attempt.input.model,
    recordingSha256: input.attempt.input.mediaSha256,
    analysisSha256,
    recordingMimeType: input.file.mimeType,
    mediaSource: "local-file" as const,
    remoteFile: {
      name: input.file.name,
      deleted: input.cleanup.deleted,
    },
    analysis: {
      ...(input.attempt.input.focus
        ? { focus: input.attempt.input.focus }
        : {}),
      maxIncidents: Math.max(1, input.moments.length),
      indexFps: 0.5,
      indexResolution: "low" as const,
      interrogationResolution: "medium" as const,
    },
    promptProvenance,
    artifacts: ["analysis.json", "manifest.json"],
  };
  const manifest: VersionedRunManifest = analysis.schemaVersion === 3
    ? {
        ...manifestBase,
        schemaVersion: 3,
        context: { mode: "none" },
      }
    : await buildMeetingManifest(input, analysis, manifestBase);
  return await validateVersionedRunImport({ analysis, manifest });
}

export async function publishHostedRun(
  database: D1Database,
  principalSub: string,
  pair: VersionedRunImport,
): Promise<{ runId: string; created: boolean }> {
  const validated = await validateVersionedRunImport(pair);
  return await createD1RunStore(database, { principal: principalSub })
    .importRun(validated);
}

function buildMeetingAnalysis(
  input: HostedPublicationInput,
  runId: string,
  recipe: { id: string; label: string },
  items: Array<{ candidate: IndexedMoment; result: AnalysisDetail }>,
): VersionedAnalysisRun {
  if (!input.meeting) throw new Error("hosted_publication_context_missing");
  return {
    schemaVersion: 2,
    runId,
    recipe,
    meeting: {
      id: input.meeting.id,
      provider: input.meeting.provider,
      ...(input.meeting.title ? { title: input.meeting.title } : {}),
      ...(input.meeting.createdAt ? { createdAt: input.meeting.createdAt } : {}),
      ...(input.meeting.sourceUrl ? { sourceUrl: input.meeting.sourceUrl } : {}),
    },
    model: input.attempt.input.model,
    matchNotes: input.matchNotes,
    items,
  };
}

async function buildMeetingManifest(
  input: HostedPublicationInput,
  analysis: Extract<VersionedAnalysisRun, { schemaVersion: 2 }>,
  manifestBase: Omit<
    Extract<VersionedRunManifest, { schemaVersion: 2 }>,
    | "schemaVersion"
    | "meetingId"
    | "transcriptSha256"
    | "contextProvider"
    | "contextTransport"
    | "transcriptAlignment"
  >,
): Promise<VersionedRunManifest> {
  if (!input.meeting) throw new Error("hosted_publication_context_missing");
  const transcriptText = input.transcript.text ?? "";
  const transcriptSha256 = await sha256Utf8(transcriptText);
  const derivedTranscript = input.transcript.origin === "gemini-audio"
    ? {
        origin: "gemini-audio" as const,
        model: input.attempt.input.model,
        sha256: transcriptSha256,
      }
    : undefined;
  const transcriptAlignment = input.attempt.input.transcriptOffsetSeconds
    !== undefined
    ? {
        offsetSeconds: input.attempt.input.transcriptOffsetSeconds,
        method: "explicit" as const,
        confidence: "high" as const,
      }
    : derivedTranscript
      ? {
          offsetSeconds: 0,
          method: "explicit" as const,
          confidence: "high" as const,
        }
      : input.transcriptAlignment
        ? {
            ...input.transcriptAlignment,
            method: "model" as const,
          }
        : {
            offsetSeconds: 0,
            method: "none" as const,
            confidence: "none" as const,
          };
  return {
    ...manifestBase,
    schemaVersion: 2,
    meetingId: analysis.meeting.id,
    transcriptSha256,
    contextProvider: input.meeting.provider,
    contextTransport: input.meeting.transport,
    transcriptAlignment,
    ...(derivedTranscript ? { derivedTranscript } : {}),
  };
}
