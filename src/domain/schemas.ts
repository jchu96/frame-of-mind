import { z } from "zod";

const contextProviderSchema = z.enum(["bluedot", "granola", "file"]);
const importanceSchema = z.enum(["high", "medium", "low"]);
export const runIdSchema = z.string()
  .min(1)
  .max(240)
  .regex(/^[a-zA-Z0-9._:-]+$/, "run ID contains characters that are unsafe in routes");

const indexedMomentSchema = z.object({
  start: z.string().min(1).max(32),
  end: z.string().min(1).max(32),
  speaker: z.string().max(240).optional(),
  surface: z.string().max(500).optional(),
  summary: z.string().min(1).max(10_000),
  kind: z.string().min(1).max(120),
  importance: importanceSchema,
}).strict();

const analysisDetailSchema = z.object({
  accepted: z.boolean(),
  kind: z.string().min(1).max(120),
  title: z.string().min(1).max(500),
  summary: z.string().min(1).max(20_000),
  details: z.array(z.object({
    label: z.string().min(1).max(240),
    value: z.string().max(20_000),
  }).strict()).max(100).optional(),
  where: z.object({
    appUrl: z.string().max(2_048).optional(),
    step: z.string().max(2_000).optional(),
    surface: z.string().max(2_000).optional(),
  }).strict().optional(),
  evidence: z.object({
    timestamp: z.string().max(32).optional(),
    verbatimUiText: z.string().max(20_000).optional(),
    reporterQuote: z.string().max(20_000).optional(),
    speaker: z.string().max(240).optional(),
  }).strict().optional(),
  steps: z.array(z.string().max(5_000)).max(100).optional(),
  importance: importanceSchema.optional(),
  confidenceNotes: z.string().max(10_000).optional(),
}).strict();

export const analysisRunSchema = z.object({
  schemaVersion: z.literal(1),
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
  items: z.array(z.object({
    candidate: indexedMomentSchema,
    result: analysisDetailSchema,
    screenshot: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(255).optional(),
  }).strict()).max(1_000),
}).strict();

export const runManifestSchema = z.object({
  schemaVersion: z.literal(1),
  toolVersion: z.string().min(1).max(120),
  promptRevision: z.string().min(1).max(120),
  runId: runIdSchema,
  startedAt: z.string().min(1).max(120),
  completedAt: z.string().min(1).max(120),
  meetingId: z.string().min(1).max(500),
  recipe: z.object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(240),
    custom: z.boolean(),
  }).strict(),
  model: z.string().min(1).max(240),
  recordingSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  transcriptSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  recordingMimeType: z.string().min(1).max(240),
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
  artifacts: z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/).max(255)).max(1_100),
}).strict();

export const runImportSchema = z.object({
  analysis: analysisRunSchema,
  manifest: runManifestSchema,
}).strict().superRefine(({ analysis, manifest }, context) => {
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
});

export type RunImport = z.infer<typeof runImportSchema>;
