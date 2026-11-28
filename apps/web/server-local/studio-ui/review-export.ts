import { z } from "zod";
import { actorSchema, candidateSchema } from "../../../../src/domain/candidates.js";
import { itemProvenance, proposalEdgesSchema } from "../../../../src/domain/proposal-edges.js";
import { enginePlanSchema, engineItemsSchema } from "../../../../src/domain/engine-plan.js";
import { runClockSchema } from "../../../../src/domain/clock.js";
import { rangeFields } from "../../../../src/domain/range-fields.js";
import { boundSchema, exactSpanSchema } from "../../../../src/domain/source-bound.js";
import type { StoredRun } from "../../shared/types.js";
import type { AnalysisItem } from "../../../../src/domain/types.js";

function optional<T>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

const itemFields = z.object(itemProvenance);
const failureFields = z.object({candidateId:z.string().optional(),proposedBy:actorSchema.optional(),gradedBy:actorSchema.nullable().optional(),
  proposal:candidateSchema.optional(),proposalEdges:proposalEdgesSchema.optional()});

function allowlistedItem(item: AnalysisItem) {
  return {
    ...itemFields.parse(item),
    ...(item.exactStillTimes && {exactStillTimes:item.exactStillTimes.map(b => boundSchema.parse(b))}),
    ...(item.screenshotExactTime && {screenshotExactTime:boundSchema.parse(item.screenshotExactTime)}),
    ...(item.stillTimes ? { stillTimes: [...item.stillTimes] } : {}),
    ...optional(item.screenTextNotFromStill, "screenTextNotFromStill"),
    candidate: {
      ...(item.candidate.proposalEdges && {proposalEdges:proposalEdgesSchema.parse(item.candidate.proposalEdges)}),
      ...(item.candidate.exactSpan && {exactSpan:exactSpanSchema.parse(item.candidate.exactSpan)}),
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
        ...(item.result.evidence.exactTime && {exactTime:boundSchema.parse(item.result.evidence.exactTime)}),
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
  return run.contextMode === "meeting"
    ? {
        ...base,
        schemaVersion: run.analysis.schemaVersion,
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
        schemaVersion: run.analysis.schemaVersion,
        context: { mode: "none" as const },
      };
}

function allowlistedManifest(run: StoredRun) {
  const manifest = run.manifest;
  const base = {
    ...rangeFields.strip().parse(manifest),
    ...(manifest.enginePlan && {enginePlan:enginePlanSchema.parse(manifest.enginePlan)}),
    ...(manifest.engineItems && {engineItems:engineItemsSchema.parse(manifest.engineItems)}),
    ...(manifest.clock && {clock:runClockSchema.parse(manifest.clock)}),
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
    ...optional(manifest.label,"label"),
    ...optional(manifest.thinkingLevel,"thinkingLevel"),
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
      ...optional(manifest.derivedTranscript.requestedLanguage, "requestedLanguage"),
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
  return run.contextMode === "meeting"
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

function allowlistedOutcome(run: StoredRun) {
  const outcome = run.outcome;
  if (!outcome) return {};
  // Counts and enum status only — the outcome contract is already sanitized,
  // and the allowlist keeps it that way if the contract ever grows.
  return {
    outcome: {
      failures: outcome.failures.map(f => ({...failureFields.parse(f),candidateOrdinal:f.candidateOrdinal,start:f.start,end:f.end,code:f.code,attempts:f.attempts,
        ...(f.issues && {issues:f.issues.map(({path,code}) => ({path,code}))}), ...("exactSpan" in f && {exactSpan:exactSpanSchema.parse(f.exactSpan)})})),
      schemaVersion: outcome.schemaVersion,
      runId: outcome.runId,
      status: outcome.status,
      candidates: {
        ...optional(outcome.candidates.outOfRange, "outOfRange"),
        indexed: outcome.candidates.indexed,
        selected: outcome.candidates.selected,
        omittedByLimit: outcome.candidates.omittedByLimit,
        validated: outcome.candidates.validated,
        accepted: outcome.candidates.accepted,
        rejected: outcome.candidates.rejected,
        failed: outcome.candidates.failed,
      },
    },
  };
}

export function coverageNotice(run: StoredRun): string | undefined {
  const outcome = run.outcome;
  if (!outcome || outcome.status === "complete") return undefined;
  const reasons = [
    outcome.candidates.failed > 0
      ? `${outcome.candidates.failed} candidate response(s) failed validation and were excluded`
      : "",
    outcome.candidates.omittedByLimit > 0
      ? `${outcome.candidates.omittedByLimit} of ${outcome.candidates.indexed} indexed candidate(s) were never interrogated because of the configured moment limit, so later parts of the recording are missing`
      : "",
  ].filter(Boolean).join("; ");
  return `${outcome.status === "partial" ? "Partial analysis" : "Analysis failed"}: ${reasons}.`;
}

export function buildReviewBundle(run: StoredRun) {
  return {
    analysis: allowlistedAnalysis(run),
    manifest: allowlistedManifest(run),
    ...allowlistedOutcome(run),
  };
}

function quote(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

export function buildReviewMarkdown(run: StoredRun): string {
  const title = run.contextMode === "meeting"
    ? run.meetingTitle || run.meetingId
    : "Video analysis";
  const notice = coverageNotice(run);
  const lines = [
    `# ${title}`,
    "",
    `Recipe: ${run.recipeLabel}`,
    `Run: ${run.runId}`,
    ...(run.outcome ? [`Outcome: ${run.outcome.status}`] : []),
    ...(notice ? ["", `> ${notice}`] : []),
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
