import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  "Connections, without a credential vault",
  "frame-of-mind-studio-shell",
  "Private local process",
  "Studio navigation",
  "Your local analysis desk",
  "Launch link expired",
  "/__studio/launch",
  "server-local/studio-media",
  "FRAME_OF_MIND_MEDIA_ROOT",
  "FRAME_OF_MIND_CHECKOUT_ROOT",
  "LocalMediaStagingAdapter",
  "createMediaExpiryJanitor",
  "/api/studio/media",
  "media.partial",
  "media.sealed",
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
  "studio_analysis_jobs",
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
