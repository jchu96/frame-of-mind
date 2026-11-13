import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function buildCliFixture(version?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fom-cli-built-"));
  execFileSync("bun", ["run", "build:cli", "--outDir", join(root, "dist")], { stdio: "pipe" });
  const metadata = JSON.parse(await readFile("package.json", "utf8"));
  if (version) metadata.version = version;
  await writeFile(join(root, "package.json"), JSON.stringify(metadata));
  await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
  return root;
}
