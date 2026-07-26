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
