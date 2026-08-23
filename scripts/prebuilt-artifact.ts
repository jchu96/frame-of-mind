import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const PREBUILT_OUTPUT_ENV = "FRAME_OF_MIND_PREBUILT_OUTPUT";
export const PREBUILT_WORKFLOWS_ENV = "FRAME_OF_MIND_PREBUILT_WORKFLOWS";
export const BUILD_OUTPUT_ENV = "FRAME_OF_MIND_BUILD_OUTPUT";
export const BUILD_DIR_ENV = "FRAME_OF_MIND_WEB_BUILD_DIR";
export const PREBUILT_MARKER = ".frame-of-mind-build.json";

export type WebBuildPreset = "node-server" | "cloudflare_module";
export type BuildPreset = WebBuildPreset | "cloudflare-workflows";

interface BuildMarker {
  readonly schemaVersion: 1;
  readonly preset: BuildPreset;
}

export class PrebuiltPresetMismatchError extends Error {
  readonly code = "prebuilt_preset_mismatch";

  constructor(expected: BuildPreset, actual: string, artifactRoot: string) {
    super(
      `prebuilt_preset_mismatch expected=${expected} actual=${actual} artifact=${artifactRoot}`,
    );
    this.name = "PrebuiltPresetMismatchError";
  }
}

export async function resolvePrebuiltWebOutput(
  expectedPreset: WebBuildPreset,
): Promise<string | undefined> {
  return resolveConfiguredArtifact(PREBUILT_OUTPUT_ENV, expectedPreset);
}

export async function resolvePrebuiltWorkflowsOutput(): Promise<string | undefined> {
  return resolveConfiguredArtifact(
    PREBUILT_WORKFLOWS_ENV,
    "cloudflare-workflows",
  );
}

export async function writeBuildMarker(
  artifactRoot: string,
  preset: BuildPreset,
): Promise<void> {
  const marker: BuildMarker = { schemaVersion: 1, preset };
  await writeFile(
    join(resolve(artifactRoot), PREBUILT_MARKER),
    `${JSON.stringify(marker)}\n`,
    { flag: "wx" },
  );
}

async function resolveConfiguredArtifact(
  environmentName: string,
  expectedPreset: BuildPreset,
): Promise<string | undefined> {
  const configured = process.env[environmentName]?.trim();
  if (!configured) return undefined;
  const artifactRoot = resolve(configured);

  let actual = "missing";
  try {
    const parsed = JSON.parse(
      await readFile(join(artifactRoot, PREBUILT_MARKER), "utf8"),
    ) as Partial<BuildMarker>;
    actual = typeof parsed.preset === "string" ? parsed.preset : "invalid";
    if (parsed.schemaVersion !== 1 || actual !== expectedPreset) {
      throw new PrebuiltPresetMismatchError(expectedPreset, actual, artifactRoot);
    }
  } catch (error) {
    if (error instanceof PrebuiltPresetMismatchError) throw error;
    throw new PrebuiltPresetMismatchError(expectedPreset, actual, artifactRoot);
  }

  return artifactRoot;
}
