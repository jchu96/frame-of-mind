import { z } from "zod";
import { isCanonicalTimestamp, timestampToSeconds } from "../lib/time.js";

function isSafeEvidenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

const contextProviderSchema = z.enum(["bluedot", "granola", "file"]);
const importanceSchema = z.enum(["high", "medium", "low"]);
export const runIdSchema = z.string()
  .min(1)
  .max(240)
  .regex(/^[a-zA-Z0-9._:-]+$/, "run ID contains characters that are unsafe in routes");

export const timestampSchema = z.string().max(32).refine(
  isCanonicalTimestamp,
  "timestamp must use HH:MM:SS with valid minute and second fields",
);

export const indexedMomentSchema = z.object({
  start: timestampSchema,
  end: timestampSchema,
  speaker: z.string().max(240).optional(),
  surface: z.string().max(500).optional(),
  summary: z.string().min(1).max(10_000),
  kind: z.string().min(1).max(120),
  importance: importanceSchema,
}).strict().superRefine((value, context) => {
  if (!isCanonicalTimestamp(value.start) || !isCanonicalTimestamp(value.end)) return;
  if (timestampToSeconds(value.end) <= timestampToSeconds(value.start)) {
    context.addIssue({
      code: "custom",
      message: "end timestamp must be after start timestamp",
      path: ["end"],
    });
  }
});

export const analysisDetailSchema = z.object({
  accepted: z.boolean(),
  kind: z.string().min(1).max(120),
  title: z.string().min(1).max(500),
  summary: z.string().min(1).max(20_000),
  details: z.array(z.object({
    label: z.string().min(1).max(240),
    value: z.string().max(20_000),
  }).strict()).max(100).optional(),
  where: z.object({
    appUrl: z.string().url().max(2_048).refine(
      isSafeEvidenceUrl,
      "app URL must use HTTPS without credentials, query parameters, or fragments",
    ).describe(
      "Optional exact HTTPS URL visibly readable in the browser address bar. " +
        "It must not contain credentials, query parameters, or fragments. " +
        "Omit this property unless the complete compliant URL is visible.",
    ).optional(),
    step: z.string().max(2_000).optional(),
    surface: z.string().max(2_000).optional(),
  }).strict().optional(),
  evidence: z.object({
    timestamp: timestampSchema.optional(),
    verbatimUiText: z.string().max(20_000).optional(),
    reporterQuote: z.string().max(20_000).optional(),
    speaker: z.string().max(240).optional(),
  }).strict().optional(),
  steps: z.array(z.string().max(5_000)).max(100).optional(),
  importance: importanceSchema.optional(),
  confidenceNotes: z.string().max(10_000).optional(),
}).strict();

const analysisItemSchema = z.object({
  candidate: indexedMomentSchema,
  result: analysisDetailSchema,
  screenshot: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(255).optional(),
}).strict().superRefine(({ candidate, result }, context) => {
  const evidence = result.evidence?.timestamp;
  if (!evidence
    || !isCanonicalTimestamp(candidate.start)
    || !isCanonicalTimestamp(candidate.end)
    || !isCanonicalTimestamp(evidence)) return;
  const seconds = timestampToSeconds(evidence);
  if (seconds < timestampToSeconds(candidate.start) || seconds > timestampToSeconds(candidate.end)) {
    context.addIssue({
      code: "custom",
      message: "evidence timestamp must fall inside the candidate range",
      path: ["result", "evidence", "timestamp"],
    });
  }
});

export const analysisRunSchema = z.object({
  schemaVersion: z.literal(2),
  runId: runIdSchema,
  recipe: z.object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(240),
  }).strict(),
  meeting: z.object({
    id: z.string().min(1).max(500),
    provider: contextProviderSchema,
    title: z.string().max(2_000).optional(),
    createdAt: z.string().max(120).optional(),
    sourceUrl: z.string().max(2_048).optional(),
  }).strict(),
  model: z.string().min(1).max(240),
  matchNotes: z.string().max(20_000),
  items: z.array(analysisItemSchema).max(1_000),
}).strict();

export const analysisRunV3Schema = z.object({
  schemaVersion: z.literal(3),
  runId: runIdSchema,
  recipe: z.object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(240),
  }).strict(),
  context: z.object({
    mode: z.literal("none"),
  }).strict(),
  model: z.string().min(1).max(240),
  matchNotes: z.string().max(20_000),
  items: z.array(analysisItemSchema).max(1_000),
}).strict();

export const versionedAnalysisRunSchema = z.union([
  analysisRunSchema,
  analysisRunV3Schema,
]);

const utcDateTimeSchema = z.string().datetime({ offset: false });

const derivedTranscriptProvenanceSchema = z.object({
  origin: z.literal("gemini-audio"),
  model: z.string().min(1).max(240),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
}).strict();

export const runManifestSchema = z.object({
  schemaVersion: z.literal(2),
  toolVersion: z.string().min(1).max(120),
  promptRevision: z.string().min(1).max(120),
  runId: runIdSchema,
  startedAt: utcDateTimeSchema,
  completedAt: utcDateTimeSchema,
  meetingId: z.string().min(1).max(500),
  recipe: z.object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(240),
    custom: z.boolean(),
    revision: z.string().min(1).max(120),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  model: z.string().min(1).max(240),
  recordingSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  transcriptSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  analysisSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recordingMimeType: z.string().min(1).max(240).refine(
    (value) => value.startsWith("video/"),
    "recording MIME type must be video",
  ),
  contextProvider: contextProviderSchema,
  contextTransport: z.enum(["mcp", "api", "file"]),
  mediaSource: z.enum(["bluedot-mcp", "signed-url", "local-file"]),
  transcriptAlignment: z.object({
    offsetSeconds: z.number().finite(),
    method: z.enum(["explicit", "model", "none"]),
    confidence: z.enum(["high", "medium", "low", "none"]),
    rationale: z.string().max(10_000).optional(),
  }).strict(),
  remoteFile: z.object({
    name: z.string().max(1_000).optional(),
    expirationTime: z.string().max(120).optional(),
    deleted: z.boolean(),
  }).strict().optional(),
  analysis: z.object({
    focus: z.string().max(10_000).optional(),
    maxIncidents: z.number().int().min(1).max(1_000),
    indexFps: z.number().positive().max(60),
    indexResolution: z.literal("low"),
    interrogationResolution: z.literal("medium"),
  }).strict(),
  derivedTranscript: derivedTranscriptProvenanceSchema.optional(),
  artifacts: z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/).max(255)).max(1_100),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    context.addIssue({
      code: "custom",
      message: "completedAt must not be before startedAt",
      path: ["completedAt"],
    });
  }
  if (value.derivedTranscript) {
    if (value.transcriptSha256.toLowerCase() !== value.derivedTranscript.sha256.toLowerCase()) {
      context.addIssue({
        code: "custom",
        message: "a derived-transcript run must record the derived transcript digest as transcriptSha256",
        path: ["transcriptSha256"],
      });
    }
    if (
      value.transcriptAlignment.offsetSeconds !== 0
      || value.transcriptAlignment.method !== "explicit"
    ) {
      context.addIssue({
        code: "custom",
        message: "a derived transcript is aligned at explicit offset 0 by construction",
        path: ["transcriptAlignment"],
      });
    }
  }
});

export const runManifestV3Schema = z.object({
  schemaVersion: z.literal(3),
  toolVersion: z.string().min(1).max(120),
  promptRevision: z.string().min(1).max(120),
  runId: runIdSchema,
  startedAt: utcDateTimeSchema,
  completedAt: utcDateTimeSchema,
  context: z.object({
    mode: z.literal("none"),
  }).strict(),
  recipe: z.object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(240),
    custom: z.boolean(),
    revision: z.string().min(1).max(120),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  model: z.string().min(1).max(240),
  recordingSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  analysisSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recordingMimeType: z.string().min(1).max(240).refine(
    (value) => value.startsWith("video/"),
    "recording MIME type must be video",
  ),
  mediaSource: z.literal("local-file"),
  remoteFile: z.object({
    name: z.string().max(1_000).optional(),
    expirationTime: z.string().max(120).optional(),
    deleted: z.boolean(),
  }).strict().optional(),
  analysis: z.object({
    focus: z.string().max(10_000).optional(),
    maxIncidents: z.number().int().min(1).max(1_000),
    indexFps: z.number().positive().max(60),
    indexResolution: z.literal("low"),
    interrogationResolution: z.literal("medium"),
  }).strict(),
  derivedTranscript: derivedTranscriptProvenanceSchema.optional(),
  artifacts: z.array(
    z.string().regex(/^[a-zA-Z0-9._-]+$/).max(255),
  ).max(1_100),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    context.addIssue({
      code: "custom",
      message: "completedAt must not be before startedAt",
      path: ["completedAt"],
    });
  }
});

export const runImportSchema = z.object({
  analysis: analysisRunSchema,
  manifest: runManifestSchema,
}).strict().superRefine(({ analysis, manifest }, context) => {
  if (analysis.runId !== manifest.runId) {
    context.addIssue({
      code: "custom",
      message: "analysis run ID does not match manifest run ID",
      path: ["manifest", "runId"],
    });
  }
  if (analysis.meeting.id !== manifest.meetingId) {
    context.addIssue({
      code: "custom",
      message: "analysis meeting ID does not match manifest meeting ID",
      path: ["manifest", "meetingId"],
    });
  }
  if (analysis.recipe.id !== manifest.recipe.id) {
    context.addIssue({
      code: "custom",
      message: "analysis recipe does not match manifest recipe",
      path: ["manifest", "recipe", "id"],
    });
  }
  if (analysis.recipe.label !== manifest.recipe.label) {
    context.addIssue({
      code: "custom",
      message: "analysis recipe label does not match manifest recipe label",
      path: ["manifest", "recipe", "label"],
    });
  }
  if (analysis.model !== manifest.model) {
    context.addIssue({
      code: "custom",
      message: "analysis model does not match manifest model",
      path: ["manifest", "model"],
    });
  }
  if (analysis.meeting.provider !== manifest.contextProvider) {
    context.addIssue({
      code: "custom",
      message: "analysis provider does not match manifest context provider",
      path: ["manifest", "contextProvider"],
    });
  }
  const invalidTransport =
    (manifest.contextProvider === "file" && manifest.contextTransport !== "file")
    || (manifest.contextProvider === "bluedot" && manifest.contextTransport !== "mcp")
    || (manifest.contextProvider === "granola"
      && manifest.contextTransport !== "mcp"
      && manifest.contextTransport !== "api");
  if (invalidTransport) {
    context.addIssue({
      code: "custom",
      message: "manifest provider and transport combination is invalid",
      path: ["manifest", "contextTransport"],
    });
  }
  if (manifest.mediaSource !== "local-file" && manifest.contextProvider !== "bluedot") {
    context.addIssue({
      code: "custom",
      message: "remote Bluedot media sources require Bluedot context",
      path: ["manifest", "mediaSource"],
    });
  }
});

export const runImportV3Schema = z.object({
  analysis: analysisRunV3Schema,
  manifest: runManifestV3Schema,
}).strict().superRefine(({ analysis, manifest }, context) => {
  if (analysis.runId !== manifest.runId) {
    context.addIssue({
      code: "custom",
      message: "analysis run ID does not match manifest run ID",
      path: ["manifest", "runId"],
    });
  }
  if (analysis.recipe.id !== manifest.recipe.id) {
    context.addIssue({
      code: "custom",
      message: "analysis recipe does not match manifest recipe",
      path: ["manifest", "recipe", "id"],
    });
  }
  if (analysis.recipe.label !== manifest.recipe.label) {
    context.addIssue({
      code: "custom",
      message: "analysis recipe label does not match manifest recipe label",
      path: ["manifest", "recipe", "label"],
    });
  }
  if (analysis.model !== manifest.model) {
    context.addIssue({
      code: "custom",
      message: "analysis model does not match manifest model",
      path: ["manifest", "model"],
    });
  }
});

export const versionedRunImportSchema = z.union([
  runImportSchema,
  runImportV3Schema,
]);

export type RunImport = z.infer<typeof runImportSchema>;
export type RunImportV3 = z.infer<typeof runImportV3Schema>;
export type VersionedRunImport = z.infer<typeof versionedRunImportSchema>;

export function isRunImportV2(
  input: VersionedRunImport,
): input is RunImport {
  return input.analysis.schemaVersion === 2
    && input.manifest.schemaVersion === 2;
}

export function isRunImportV3(
  input: VersionedRunImport,
): input is RunImportV3 {
  return input.analysis.schemaVersion === 3
    && input.manifest.schemaVersion === 3;
}
