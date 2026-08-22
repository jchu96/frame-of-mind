import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const nuxtConfigPath = resolve("apps/web/nuxt.config.ts");
const nuxtConfig = await Bun.file(nuxtConfigPath).text();
const geminiImportSpecs = [...nuxtConfig.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
  .map((match) => match[1])
  .filter((specifier) => specifier.includes("src/adapters/gemini"));
const forbiddenGeminiImports = geminiImportSpecs.filter(
  (specifier) => !specifier.includes("gemini-model"),
);
if (forbiddenGeminiImports.length) {
  throw new Error(
    `nuxt.config.ts imports the Gemini adapter graph: ${
      forbiddenGeminiImports.join(", ")
    }`,
  );
}
console.log(
  "nuxt.config.ts Gemini import boundary clean: gemini-model only; "
  + `${geminiImportSpecs.length} allowed import(s).`,
);

const outputRoot = resolve("apps/web/.output");
const forbidden = [
  "bun:",
  "server-local/studio-spike",
  "FRAME_OF_MIND_STUDIO_SPIKE",
  "FRAME_OF_MIND_STUDIO_SPIKE_DIR",
  "/api/__studio-spike/",
  "stream-upload.partial",
  "stream-upload.sealed",
  "server-local/studio-session",
  "FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN",
  "frame_of_mind_studio",
  "/__studio/bootstrap",
  "/api/studio/",
  "server-local/studio-configuration",
  "ProcessRuntimeSecretResolver",
  "server-local/studio-ui",
  "studioDefaultModel",
  "Bring your own keys",
  "frame-of-mind-studio-shell",
  "Private local process",
  "Studio navigation",
  "Turn a recording into findings",
  "/activity",
  "Activity · Frame of Mind",
  "Launch link expired",
  "/__studio/launch",
  "server-local/studio-media",
  "FRAME_OF_MIND_MEDIA_ROOT",
  "FRAME_OF_MIND_CHECKOUT_ROOT",
  "LocalMediaStagingAdapter",
  "createMediaExpiryJanitor",
  "/api/studio/media",
  "/api/studio/media/:id/cleanup-retry",
  "media.partial",
  "media.sealed",
  "server-local/studio-context",
  "server-local/studio-catalog",
  "FRAME_OF_MIND_CONTEXT_ROOT",
  "LocalContextFileStagingAdapter",
  "createContextExpiryJanitor",
  "/api/context-files",
  "/api/studio/catalog/",
  "server-local/studio-jobs",
  "LocalSqliteJobRepository",
  "LocalStudioJobWorker",
  "OrchestratedAnalysisJobExecutor",
  "LocalStudioJobControl",
  "LocalMediaReuseGuard",
  "LocalInitialMediaGuard",
  "LocalStudioAnalyzeOptionsResolver",
  "createLocalStudioJobRuntime",
  "resolveInUsePath",
  "deleteEphemeralExecutionLease",
  "StudioJobApiUnavailableError",
  "/api/studio/jobs",
  "/api/studio/jobs/:id/reimport",
  "StudioRunReimportError",
  "/api/studio/composer/jobs",
  "studio_analysis_jobs",
  "sentry.client.config",
  "sentry.server.config",
  "SENTRY_DSN",
  "SanitizedTelemetryError",
  "@sentry/node",
  "@sentry/nuxt",
  "@sentry/cloudflare",
  "Sentry.init",
  "server-spikes/hosted-workflows",
  "FRAME_OF_MIND_HOSTED_WORKFLOW_SPIKE",
  "/api/__hosted-workflow-spike",
  "HOSTED_WORKFLOWS",
  "/api/_spike/stream",
  "FRAME_OF_MIND_HOSTED_STREAM_SPIKE_ROUTE_V1",
  "HostedWorkflowAnalysisJobExecutor",
  "/api/hosted/jobs",
  "/api/hosted/composer/jobs",
  "data-hosted-studio-shell",
  "data-hosted-activity-page",
  "data-hosted-composer",
];
const requiredReviewMarkers = [
  "Primary navigation",
  "Import run",
];

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}

const matches: string[] = [];
const foundReviewMarkers = new Set<string>();
for (const path of await files(outputRoot)) {
  const contents = await Bun.file(path).text();
  for (const marker of forbidden) {
    if (contents.includes(marker)) matches.push(`${path}: ${marker}`);
  }
  for (const marker of requiredReviewMarkers) {
    if (contents.includes(marker)) foundReviewMarkers.add(marker);
  }
}

if (matches.length) {
  throw new Error(
    `Cloudflare artifact contains local-only Studio markers:\n${matches.join("\n")}`,
  );
}
const missingReviewMarkers = requiredReviewMarkers.filter(
  (marker) => !foundReviewMarkers.has(marker),
);
if (missingReviewMarkers.length) {
  throw new Error(
    "Cloudflare artifact is missing the hosted review shell markers: "
    + missingReviewMarkers.join(", "),
  );
}

console.log(
  `Cloudflare boundary clean: ${forbidden.length} forbidden markers absent; `
  + `${requiredReviewMarkers.length} hosted review markers present.`,
);
