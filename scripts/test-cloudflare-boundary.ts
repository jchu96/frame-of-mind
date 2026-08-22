import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ad11ForbiddenMarkers,
  ad11RequiredMarkers,
  checkCloudflareBoundary,
} from "./check-cloudflare-boundary";

const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-boundary-"));
try {
  const positiveRoot = join(temporaryRoot, "positive");
  await writeFixture(positiveRoot, ad11RequiredMarkers.join("\n"));
  await checkCloudflareBoundary(positiveRoot);
  console.log("CLOUDFLARE_BOUNDARY_FIXTURE positive=PASS");

  const forbiddenRoot = join(temporaryRoot, "forbidden");
  await writeFixture(
    forbiddenRoot,
    `${ad11RequiredMarkers.join("\n")}\n${ad11ForbiddenMarkers[0]}`,
  );
  await expectFailure(forbiddenRoot, "AD-11 forbidden markers");
  console.log("CLOUDFLARE_BOUNDARY_FIXTURE forbidden=PASS");

  const missingRoot = join(temporaryRoot, "missing");
  await writeFixture(missingRoot, ad11RequiredMarkers.slice(1).join("\n"));
  await expectFailure(missingRoot, "AD-11 required markers");
  console.log("CLOUDFLARE_BOUNDARY_FIXTURE missing=PASS");

  const sensitiveRoot = join(temporaryRoot, "wrapper-sensitive");
  await writeFixture(
    sensitiveRoot,
    ad11RequiredMarkers.join("\n"),
    "\nconst leakedProviderBinding = 'GEMINI_API_KEY';\n",
  );
  await expectFailure(sensitiveRoot, "provider-sensitive markers");
  console.log("CLOUDFLARE_BOUNDARY_FIXTURE wrapper_sensitive=PASS");
  console.log("CLOUDFLARE_BOUNDARY_SELF_TEST PASSED");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function writeFixture(
  root: string,
  bundle: string,
  wrapperSuffix = "",
): Promise<void> {
  await mkdir(join(root, "server"), { recursive: true });
  const wrapper = await readFile(resolve("scripts/hosted-entry.mjs"), "utf8");
  await writeFile(join(root, "server", "hosted-entry.mjs"), wrapper + wrapperSuffix);
  await writeFile(join(root, "server", "bundle.mjs"), bundle);
}

async function expectFailure(root: string, marker: string): Promise<void> {
  try {
    await checkCloudflareBoundary(root);
  } catch (error) {
    if (error instanceof Error && error.message.includes(marker)) return;
    throw error;
  }
  throw new Error(`Expected boundary fixture to fail with ${marker}.`);
}
