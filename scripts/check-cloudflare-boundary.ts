import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

export const ad11RequiredMarkers = [
  "/api/hosted/media",
  "/api/hosted/jobs",
  "/hosted/activity",
  "HostedWorkflowAnalysisJobExecutor",
  "principal_spend_cap_exceeded",
  "data-hosted-studio-shell",
] as const;

export const ad11ForbiddenMarkers = [
  "/__studio/bootstrap",
  "/api/studio/jobs",
  "server-local/studio-session",
  "server-local/studio-media",
  "server-local/studio-ui/activity",
  "LocalMediaStagingAdapter",
  "LocalSqliteJobRepository",
  "OrchestratedAnalysisJobExecutor",
  "bun:sqlite",
] as const;

// Local-only surfaces added after AD-11 was frozen. They extend the forbidden
// scan without changing the AD-11 set the release rehearsal reports.
export const localOnlyForbiddenMarkers = [
  "server-local/studio-maintenance",
  "/api/studio/maintenance",
  "FRAME_OF_MIND_MAINTENANCE_INTERVAL_MS",
  "maintenance_stale_job",
] as const;

export const hostedWrapperMarker = "FRAME_OF_MIND_HOSTED_ENTRY_V1";
const wrapperSensitiveMarkers = [
  "GEMINI_API_KEY",
  "geminiFileUri",
  "gemini_file_uri",
  "generativelanguage.googleapis.com",
  "transcript",
] as const;

export interface CloudflareBoundaryReceipt {
  outputRoot: string;
  filesScanned: number;
  requiredMarkers: number;
  forbiddenMarkers: number;
}

export async function checkCloudflareBoundary(
  outputRoot = resolve(repositoryRoot, "apps/web/.output"),
): Promise<CloudflareBoundaryReceipt> {
  await checkNuxtGeminiImportBoundary();
  const resolvedOutputRoot = resolve(outputRoot);
  const artifactFiles = await files(resolvedOutputRoot);
  if (artifactFiles.length === 0) {
    throw new Error(`Cloudflare artifact is empty: ${resolvedOutputRoot}`);
  }

  const matches: string[] = [];
  const foundRequiredMarkers = new Set<string>();
  for (const path of artifactFiles) {
    const contents = await readFile(path, "utf8");
    for (const marker of [...ad11ForbiddenMarkers, ...localOnlyForbiddenMarkers]) {
      if (contents.includes(marker)) {
        matches.push(`${relative(resolvedOutputRoot, path)}: ${marker}`);
      }
    }
    for (const marker of ad11RequiredMarkers) {
      if (contents.includes(marker)) foundRequiredMarkers.add(marker);
    }
  }

  if (matches.length) {
    throw new Error(
      `Cloudflare artifact contains AD-11 forbidden markers:\n${matches.join("\n")}`,
    );
  }
  const missingRequiredMarkers = ad11RequiredMarkers.filter(
    (marker) => !foundRequiredMarkers.has(marker),
  );
  if (missingRequiredMarkers.length) {
    throw new Error(
      "Cloudflare artifact is missing AD-11 required markers: "
      + missingRequiredMarkers.join(", "),
    );
  }

  const hostedEntryPath = join(resolvedOutputRoot, "server", "hosted-entry.mjs");
  const hostedEntry = await readFile(hostedEntryPath, "utf8").catch(() => {
    throw new Error("Cloudflare artifact is missing server/hosted-entry.mjs.");
  });
  if (!hostedEntry.includes(hostedWrapperMarker)) {
    throw new Error(`Cloudflare hosted entry is missing ${hostedWrapperMarker}.`);
  }
  const wrapperSensitiveMatches = wrapperSensitiveMarkers.filter(
    (marker) => hostedEntry.toLowerCase().includes(marker.toLowerCase()),
  );
  if (wrapperSensitiveMatches.length) {
    throw new Error(
      "Cloudflare hosted entry contains provider-sensitive markers: "
      + wrapperSensitiveMatches.join(", "),
    );
  }

  return {
    outputRoot: resolvedOutputRoot,
    filesScanned: artifactFiles.length,
    requiredMarkers: ad11RequiredMarkers.length,
    forbiddenMarkers:
      ad11ForbiddenMarkers.length + localOnlyForbiddenMarkers.length,
  };
}

async function checkNuxtGeminiImportBoundary(): Promise<void> {
  const nuxtConfig = await readFile(
    resolve(repositoryRoot, "apps/web/nuxt.config.ts"),
    "utf8",
  );
  const geminiImportSpecs = [...nuxtConfig.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier?.includes("src/adapters/gemini"));
  const forbiddenGeminiImports = geminiImportSpecs.filter(
    (specifier) => !specifier?.includes("gemini-model"),
  );
  if (forbiddenGeminiImports.length) {
    throw new Error(
      `nuxt.config.ts imports the Gemini adapter graph: ${forbiddenGeminiImports.join(", ")}`,
    );
  }
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(?:css|html|js|json|map|mjs|txt)$/.test(entry.name)) result.push(path);
  }
  return result.sort();
}

if (import.meta.main) {
  const receipt = await checkCloudflareBoundary(process.argv[2]);
  console.log(
    `Cloudflare boundary clean: ${receipt.forbiddenMarkers} forbidden markers absent; `
    + `${receipt.requiredMarkers} AD-11 required markers present; `
    + `${receipt.filesScanned} artifact files scanned; hosted wrapper clean.`,
  );
}
