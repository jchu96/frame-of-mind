import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = resolve(repositoryRoot, "scripts/hosted-entry.mjs");
const outputPath = resolve(repositoryRoot, "apps/web/.output/server/hosted-entry.mjs");
const indexPath = resolve(repositoryRoot, "apps/web/.output/server/index.mjs");

if (!(await Bun.file(indexPath).exists())) {
  throw new Error("Build the Cloudflare Nitro artifact before emitting hosted-entry.mjs.");
}

const source = await readFile(sourcePath);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, source);

const emitted = await readFile(outputPath);
if (!source.equals(emitted)) {
  throw new Error("hosted-entry.mjs did not match its deterministic source template.");
}

console.log(`Hosted Cloudflare entry emitted: ${outputPath} (${emitted.byteLength} bytes).`);
