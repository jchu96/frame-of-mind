import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach } from "vitest";

export function mediaFixtures(prepare: (dir: string) => void | Promise<void>) {
  let dir: string, ready: Promise<void>;
  beforeAll(async () => {
    ready = mkdtemp(join(tmpdir(), "fom-media-")).then(path => { dir = path; return prepare(path); });
    // Surface a setup failure on every dependent case through its own hook.
    await Promise.allSettled([ready]);
  });
  beforeEach(() => ready);
  afterAll(async () => { if (dir) await rm(dir, {recursive: true, force: true}); });
  return (...parts: string[]) => join(dir, ...parts);
}
