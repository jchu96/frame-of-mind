import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { acquireE2EResourceLease } from "../apps/web/e2e/support/isolation";

export async function pruneCache(cacheRoot: string, currentEntry: string): Promise<void> {
  const listing = await readdir(cacheRoot, { withFileTypes: true });
  const names = new Set(listing.map(entry => entry.name));
  const entries = [];
  for (const entry of listing) {
    if (!(entry.isDirectory() && /^(local|hosted)-[a-f0-9]{64}$/.test(entry.name))) continue;
    const path = join(cacheRoot, entry.name);
    const mtimeMs = await entryMtime(path);
    if (mtimeMs !== undefined) entries.push({ name: entry.name, path, mtimeMs });
  }

  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const { name, path, mtimeMs } of entries.slice(5)) {
    if (path === currentEntry || names.has(`${name}.lock`)) continue;
    // A peer can start copying after readdir. Try its entry lease and
    // recheck the timestamp in case the peer refreshed the build since then.
    const lease = await acquireE2EResourceLease(`${path}.lock`, { wait: false });
    if (!lease) continue;
    try {
      if (await entryMtime(path) === mtimeMs) {
        await rm(path, { recursive: true, force: true });
      }
    } finally {
      await lease.release();
    }
  }
}

async function entryMtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
