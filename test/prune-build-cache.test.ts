import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  acquireE2EResourceLease,
  type E2EResourceLease,
  resourceLeaseTokenMatches,
} from "../apps/web/e2e/support/isolation";
import { pruneCache } from "../scripts/prune-build-cache";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, stat: vi.fn(actual.stat), mkdir: vi.fn(actual.mkdir) };
});
const real = await vi.importActual<typeof fs>("node:fs/promises");
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "gate-prune-"));
  vi.stubEnv("FRAME_OF_MIND_BUILD_CACHE", root);
});
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function entries(count: number) {
  return Promise.all(Array.from({ length: count }, async (_, i) => {
    const lane = i % 2 ? "hosted" : "local";
    const path = join(root, `${lane}-${i.toString(16).padStart(64, "0")}`);
    await fs.mkdir(path);
    await fs.utimes(path, 100 + i, 100 + i);
    return path;
  }));
}

test("skips a listed entry removed while a peer releases its lease", async () => {
  const [entry] = await entries(1);
  const peer = await acquireE2EResourceLease(`${entry}.lock`);
  vi.mocked(fs.stat).mockImplementationOnce(async path => {
    await fs.rm(entry, { recursive: true });
    await peer.release();
    return real.stat(path);
  });
  await pruneCache(root, entry);
  expect(await fs.readdir(root)).toEqual([]);
});

test("counts and removes only published build directories", async () => {
  const builds = await entries(6);
  const released = `${builds[0]}.lock.released-token`;
  const other = join(root, "unrelated");
  await fs.mkdir(released);
  await fs.utimes(released, 1, 1);
  await fs.mkdir(other);
  await pruneCache(root, builds[5]);
  expect((await fs.readdir(root)).sort()).toEqual(
    [...builds.slice(1), released, other].map(path => basename(path)).sort(),
  );
});

test("propagates a permission error from a listed entry", async () => {
  const [entry] = await entries(1);
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  vi.mocked(fs.stat).mockRejectedValueOnce(denied);
  await expect(pruneCache(root, entry)).rejects.toBe(denied);
});

test("preserves the oldest entry while a peer holds its lease", async () => {
  const builds = await entries(6);
  const peer = await acquireE2EResourceLease(`${builds[0]}.lock`);
  try {
    await pruneCache(root, builds[5]);
    expect((await fs.stat(builds[0])).isDirectory()).toBe(true);
  } finally {
    await peer.release();
  }
});

function afterMtimeSample(entry: string, run: () => Promise<void>) {
  vi.mocked(fs.stat).mockImplementation(async path => {
    const sample = await real.stat(path);
    if (path === entry) {
      vi.mocked(fs.stat).mockImplementation(real.stat);
      await run();
    }
    return sample;
  });
}

test.each([
  { scenario: "holds the lease after the listing", refresh: false },
  { scenario: "refreshes and holds the lease past its wait deadline", refresh: true },
])("skips eviction when a peer $scenario", async ({ refresh }) => {
  const builds = await entries(6);
  const lock = `${builds[0]}.lock`;
  let peer: E2EResourceLease | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Promise.withResolvers<never>();
  afterMtimeSample(builds[0], async () => {
    peer = await acquireE2EResourceLease(lock);
    timer = setTimeout(() => deadline.reject(new Error("Pruning waited on the peer lease.")), 2_000);
    if (refresh) {
      await fs.utimes(builds[0], 200, 200);
      // Advance the lease clock after eviction starts its acquisition.
      const pastDeadline = Date.now() + 31 * 60_000;
      vi.mocked(fs.mkdir).mockImplementationOnce(path => {
        vi.spyOn(Date, "now").mockReturnValue(pastDeadline);
        return real.mkdir(path);
      });
    }
  });

  const pruning = pruneCache(root, builds[5]);
  try {
    await Promise.race([pruning, deadline.promise]);
    expect(peer && await resourceLeaseTokenMatches(lock, peer.token)).toBe(true);
    expect((await real.stat(builds[0])).mtimeMs).toBe(refresh ? 200_000 : 100_000);
  } finally {
    clearTimeout(timer);
    vi.restoreAllMocks();
    await peer?.release();
    await pruning;
  }
});

test("rechecks a candidate refreshed by a peer after the listing", async () => {
  const builds = await entries(6);
  afterMtimeSample(builds[0], async () => {
    const peer = await acquireE2EResourceLease(`${builds[0]}.lock`);
    try {
      await fs.utimes(builds[0], 200, 200);
    } finally {
      await peer.release();
    }
  });
  await pruneCache(root, builds[5]);
  expect((await fs.stat(builds[0])).mtimeMs).toBe(200_000);
});

test.each([0, 6])("keeps the five newest and current entry %i", async current => {
  const builds = await entries(7);
  await pruneCache(root, builds[current]);
  const expected = new Set([...builds.slice(2), builds[current]]);
  expect((await fs.readdir(root)).sort()).toEqual(
    [...expected].map(path => basename(path)).sort(),
  );
});
