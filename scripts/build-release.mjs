import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { version, packageManager } = JSON.parse(await readFile("package.json", "utf8"));
const tag = process.argv[2];
if (tag !== undefined && tag !== `v${version}`) {
  throw new Error(`Release tag must equal v${version}`);
}
const buildEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
const bun = execFileSync("bun", ["--no-env-file", "--version"], { encoding: "utf8", env: buildEnv }).trim();
if (`bun@${bun}` !== packageManager) throw new Error(`Use ${packageManager} for releases`);
const inputs = ["schemas/cli", "src", "package.json", "bun.lock", "tsconfig.json", "LICENSE", "scripts/build-release.mjs", "scripts/release-notices"];
if (execFileSync("git", ["status", "--porcelain", "--", ...inputs], { encoding: "utf8" }).trim()) {
  throw new Error("Commit the release inputs before building");
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const stage = await mkdtemp(".release-build-");
try {
  const metafile = join(stage, "meta.json");
  execFileSync("bun", [
    "--no-env-file", "--no-install", "build", "src/cli.ts", "--target=node", "--format=esm",
    "--packages=bundle", "--external=bun:sqlite", "--minify-whitespace", "--env=disable",
    "--define", `__FRAMEOFMIND_RELEASE_VERSION__=${JSON.stringify(version)}`,
    "--define", `__FRAMEOFMIND_RELEASE_COMMIT__=${JSON.stringify(commit)}`,
    `--metafile=${metafile}`, `--outfile=${join(stage, "frameofmind.mjs")}`,
  ], { env: buildEnv, stdio: "inherit" });
  execFileSync("bun", ["--no-env-file", "--no-install", "scripts/release-notices/index.mjs",
    metafile, join(stage, "THIRD-PARTY-NOTICES.txt")], { env: buildEnv, stdio: "inherit" });
  await rm(metafile);
  await copyFile("LICENSE", join(stage, "LICENSE"));
  const metadata = { version, commit, node: process.versions.node, bun };
  await writeFile(join(stage, "release.json"), JSON.stringify(metadata, null, 2) + "\n");
  for (const name of await readdir("schemas/cli")) {
    await copyFile(join("schemas/cli", name), join(stage, name));
  }
  const sums = [];
  for (const name of (await readdir(stage)).sort()) {
    const hash = createHash("sha256").update(await readFile(join(stage, name))).digest("hex");
    sums.push(`${hash}  ${name}`);
  }
  await writeFile(join(stage, "SHA256SUMS"), sums.join("\n") + "\n");
  await rename(stage, "release");
  console.log(`RELEASE_BUILD version=${version} commit=${commit} status=PASS`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
