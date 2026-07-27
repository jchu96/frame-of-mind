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
  "studio_analysis_jobs",
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
for (const path of await files(outputRoot)) {
  const contents = await Bun.file(path).text();
  for (const marker of forbidden) {
    if (contents.includes(marker)) matches.push(`${path}: ${marker}`);
  }
}

if (matches.length) {
  throw new Error(
    `Cloudflare artifact contains local-only Studio markers:\n${matches.join("\n")}`,
  );
}

console.log(
  `Cloudflare boundary clean: ${forbidden.length} forbidden markers absent.`,
);
