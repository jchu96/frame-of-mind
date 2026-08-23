import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

const RUNTIME_LOCK = join(tmpdir(), "frame-of-mind-e2e-runtime.lock");
export const E2E_RUNTIME_LEASE_TOKEN_ENV = "FRAME_OF_MIND_E2E_RUNTIME_LEASE_TOKEN";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_REAPER_FILE = ".reaping";
const LOCK_OWNER_GRACE_MS = 5_000;
const LOCK_POLL_MS = 100;
const LOCK_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;

export interface E2EIsolation {
  readonly id: string;
  readonly root: string;
  readonly persistRoot: string;
  readonly databaseName: string;
  readonly databaseId: string;
  workerName(role: string): string;
  reservePort(): Promise<number>;
  cleanup(): Promise<void>;
}

export interface E2EResourceLease {
  readonly token: string;
  release(): Promise<void>;
}

export async function createE2EIsolation(
  label: string,
  parentRoot?: string,
): Promise<E2EIsolation> {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";
  const resolvedParent = parentRoot ? resolve(parentRoot) : resolve(tmpdir());
  if (parentRoot) assertManagedRoot(resolvedParent);
  // Top-level runners own the machine-wide workerd/Chromium budget. A hosted
  // fixture created beneath their managed root is nested work in the same run
  // and must not try to acquire the lease again.
  const inheritedLease = !parentRoot && await hasInheritedRuntimeLease();
  const resourceLease = parentRoot || inheritedLease
    ? undefined
    : await acquireE2EResourceLease();

  let root: string;
  try {
    await mkdir(resolvedParent, { recursive: true });
    root = await mkdtemp(join(resolvedParent, `frame-of-mind-e2e-${safeLabel}-`));
  } catch (error) {
    await resourceLease?.release();
    throw error;
  }
  const id = randomUUID().replaceAll("-", "");
  const persistRoot = join(root, "wrangler-state");
  try {
    await mkdir(persistRoot, { recursive: true });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    await resourceLease?.release();
    throw error;
  }

  let cleaned = false;

  return {
    id,
    root,
    persistRoot,
    databaseName: `fom-e2e-${safeLabel}-${id.slice(0, 12)}`,
    databaseId: randomUUID(),
    workerName: (role: string) => {
      const safeRole = role.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "worker";
      return `fom-e2e-${safeRole.slice(0, 35)}-${id.slice(0, 12)}`;
    },
    reservePort: reserveFreePort,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        await resourceLease?.release();
      }
    },
  };
}

export async function acquireE2EResourceLease(
  lockPath = RUNTIME_LOCK,
): Promise<E2EResourceLease> {
  const resolvedLock = resolve(lockPath);
  const token = randomUUID();
  const startedAt = Date.now();

  for (;;) {
    try {
      await mkdir(resolvedLock);
      try {
        await writeFile(join(resolvedLock, LOCK_OWNER_FILE), JSON.stringify({
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
        }));
      } catch (error) {
        await rm(resolvedLock, { recursive: true, force: true });
        throw error;
      }
      let released = false;
      return {
        token,
        release: async () => {
          if (released) return;
          released = true;
          const owner = await readLockOwner(resolvedLock);
          if (owner?.token !== token) return;
          const releasedPath = `${resolvedLock}.released-${token}`;
          try {
            await rename(resolvedLock, releasedPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          await rm(releasedPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (await reapStaleLock(resolvedLock)) continue;
    if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
      throw new Error("Timed out waiting for the machine-wide E2E runtime lease.");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_POLL_MS));
  }
}

async function hasInheritedRuntimeLease(): Promise<boolean> {
  const inheritedToken = process.env[E2E_RUNTIME_LEASE_TOKEN_ENV];
  if (!inheritedToken) return false;
  return resourceLeaseTokenMatches(RUNTIME_LOCK, inheritedToken);
}

export async function resourceLeaseTokenMatches(
  lockPath: string,
  token: string,
): Promise<boolean> {
  return (await readLockOwner(resolve(lockPath)))?.token === token;
}

export async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveReady());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve an E2E port.");
  }
  const port = address.port;
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error ? reject(error) : resolveClosed());
  });
  return port;
}

export function assertManagedRoot(root: string): void {
  const resolved = resolve(root);
  const systemTemp = resolve(tmpdir());
  const directChild = dirname(resolved) === systemTemp
    && basename(resolved).startsWith("frame-of-mind-e2e-");
  const nestedChild = resolved.startsWith(`${systemTemp}/frame-of-mind-e2e-`);
  if (!directChild && !nestedChild) {
    throw new Error("E2E state must stay inside a managed OS-temp directory.");
  }
}

export async function withE2EBuildLock<T>(run: () => Promise<T>): Promise<T> {
  const lock = join(tmpdir(), "frame-of-mind-e2e-web-build.lock");
  const lease = await acquireE2EResourceLease(lock);
  try {
    return await run();
  } finally {
    await lease.release();
  }
}

interface LockOwner {
  pid: number;
  token: string;
}

async function reapStaleLock(lockPath: string): Promise<boolean> {
  const observedOwner = await readLockOwner(lockPath);
  if (observedOwner && processIsAlive(observedOwner.pid)) return false;
  if (!observedOwner) {
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs < LOCK_OWNER_GRACE_MS) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }

  const reaperPath = join(lockPath, LOCK_REAPER_FILE);
  try {
    await writeFile(reaperPath, String(process.pid), { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code === "ENOENT") return true;
    throw error;
  }

  const claimedOwner = await readLockOwner(lockPath);
  if (
    !sameLockOwner(observedOwner, claimedOwner)
    || (claimedOwner && processIsAlive(claimedOwner.pid))
  ) {
    await rm(reaperPath, { force: true });
    return false;
  }

  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8"),
    ) as Partial<LockOwner>;
    return Number.isSafeInteger(parsed.pid) && typeof parsed.token === "string"
      ? parsed as LockOwner
      : undefined;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT"
      || error instanceof SyntaxError
    ) {
      return undefined;
    }
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameLockOwner(
  left: LockOwner | undefined,
  right: LockOwner | undefined,
): boolean {
  return left?.pid === right?.pid && left?.token === right?.token;
}
