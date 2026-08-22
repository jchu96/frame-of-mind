import type { StoredRun } from "../../shared/types.js";
import type { AnalysisItem } from "../../../../src/domain/types.js";

function optional<T>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function allowlistedItem(item: AnalysisItem) {
  return {
    candidate: {
      start: item.candidate.start,
      end: item.candidate.end,
      ...optional(item.candidate.speaker, "speaker"),
      ...optional(item.candidate.surface, "surface"),
      summary: item.candidate.summary,
      kind: item.candidate.kind,
      importance: item.candidate.importance,
    },
    result: {
      accepted: item.result.accepted,
      kind: item.result.kind,
      title: item.result.title,
      summary: item.result.summary,
      ...(item.result.details
        ? { details: item.result.details.map((detail) => ({
            label: detail.label,
            value: detail.value,
          })) }
        : {}),
      ...(item.result.where ? { where: {
        ...optional(item.result.where.appUrl, "appUrl"),
        ...optional(item.result.where.step, "step"),
        ...optional(item.result.where.surface, "surface"),
      } } : {}),
      ...(item.result.evidence ? { evidence: {
        ...optional(item.result.evidence.timestamp, "timestamp"),
        ...optional(item.result.evidence.verbatimUiText, "verbatimUiText"),
        ...optional(item.result.evidence.reporterQuote, "reporterQuote"),
        ...optional(item.result.evidence.speaker, "speaker"),
      } } : {}),
      ...(item.result.steps ? { steps: [...item.result.steps] } : {}),
      ...optional(item.result.importance, "importance"),
      ...optional(item.result.confidenceNotes, "confidenceNotes"),
    },
    ...optional(item.screenshot, "screenshot"),
  };
}

function allowlistedAnalysis(run: StoredRun) {
  const base = {
    schemaVersion: run.analysis.schemaVersion,
    runId: run.analysis.runId,
    recipe: {
      id: run.analysis.recipe.id,
      label: run.analysis.recipe.label,
    },
    model: run.analysis.model,
    matchNotes: run.analysis.matchNotes,
    items: run.analysis.items.map(allowlistedItem),
  };
  return run.schemaVersion === 2
    ? {
        ...base,
        schemaVersion: 2 as const,
        meeting: {
          id: run.analysis.meeting.id,
          provider: run.analysis.meeting.provider,
          ...optional(run.analysis.meeting.title, "title"),
          ...optional(run.analysis.meeting.createdAt, "createdAt"),
          ...optional(run.analysis.meeting.sourceUrl, "sourceUrl"),
        },
      }
    : {
        ...base,
        schemaVersion: 3 as const,
        context: { mode: "none" as const },
      };
}

function allowlistedManifest(run: StoredRun) {
  const manifest = run.manifest;
  const base = {
    schemaVersion: manifest.schemaVersion,
    toolVersion: manifest.toolVersion,
    promptRevision: manifest.promptRevision,
    runId: manifest.runId,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    recipe: {
      id: manifest.recipe.id,
      label: manifest.recipe.label,
      custom: manifest.recipe.custom,
      revision: manifest.recipe.revision,
      sha256: manifest.recipe.sha256,
    },
    model: manifest.model,
    recordingSha256: manifest.recordingSha256,
    analysisSha256: manifest.analysisSha256,
    recordingMimeType: manifest.recordingMimeType,
    mediaSource: manifest.mediaSource,
    ...(manifest.remoteFile ? { remoteFile: {
      ...optional(manifest.remoteFile.name, "name"),
      ...optional(manifest.remoteFile.expirationTime, "expirationTime"),
      deleted: manifest.remoteFile.deleted,
    } } : {}),
    analysis: {
      ...optional(manifest.analysis.focus, "focus"),
      maxIncidents: manifest.analysis.maxIncidents,
      indexFps: manifest.analysis.indexFps,
      indexResolution: manifest.analysis.indexResolution,
      interrogationResolution: manifest.analysis.interrogationResolution,
    },
    ...(manifest.derivedTranscript ? { derivedTranscript: {
      origin: manifest.derivedTranscript.origin,
      model: manifest.derivedTranscript.model,
      sha256: manifest.derivedTranscript.sha256,
    } } : {}),
    ...(manifest.promptProvenance ? { promptProvenance: {
      indexPrefixSha256: manifest.promptProvenance.indexPrefixSha256,
      interrogationPrefixSha256: manifest.promptProvenance.interrogationPrefixSha256,
      modelRouting: {
        requestedModel: manifest.promptProvenance.modelRouting.requestedModel,
        reason: manifest.promptProvenance.modelRouting.reason,
      },
    } } : {}),
    artifacts: [...manifest.artifacts],
  };
  return run.schemaVersion === 2
    ? {
        ...base,
        schemaVersion: 2 as const,
        meetingId: run.manifest.meetingId,
        transcriptSha256: run.manifest.transcriptSha256,
        contextProvider: run.manifest.contextProvider,
        contextTransport: run.manifest.contextTransport,
        transcriptAlignment: {
          offsetSeconds: run.manifest.transcriptAlignment.offsetSeconds,
          method: run.manifest.transcriptAlignment.method,
          confidence: run.manifest.transcriptAlignment.confidence,
          ...optional(run.manifest.transcriptAlignment.rationale, "rationale"),
        },
      }
    : {
        ...base,
        schemaVersion: 3 as const,
        context: { mode: "none" as const },
      };
}

export function buildReviewBundle(run: StoredRun) {
  return {
    analysis: allowlistedAnalysis(run),
    manifest: allowlistedManifest(run),
  };
}

function quote(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

export function buildReviewMarkdown(run: StoredRun): string {
  const title = run.schemaVersion === 2
    ? run.meetingTitle || run.meetingId
    : "Video analysis";
  const lines = [
    `# ${title}`,
    "",
    `Recipe: ${run.recipeLabel}`,
    `Run: ${run.runId}`,
    "",
    run.matchNotes,
  ];
  for (const item of run.analysis.items) {
    lines.push(
      "",
      `## ${item.result.accepted ? "Accepted" : "Rejected"}: ${item.result.title}`,
      "",
      `Timestamp: ${item.result.evidence?.timestamp ?? item.candidate.start}`,
      `Importance: ${item.result.importance ?? item.candidate.importance}`,
      "",
      item.result.summary,
    );
    if (item.result.evidence?.reporterQuote) {
      lines.push("", quote(item.result.evidence.reporterQuote));
    }
    for (const detail of item.result.details ?? []) {
      lines.push("", `- ${detail.label}: ${detail.value}`);
    }
    if (item.result.confidenceNotes) {
      lines.push("", `Confidence: ${item.result.confidenceNotes}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function reviewBundleFilename(runId: string): string {
  return `frame-of-mind-${runId}.run-bundle.json`;
}
