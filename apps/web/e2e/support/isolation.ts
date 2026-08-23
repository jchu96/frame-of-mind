import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

export interface E2EIsolation {
  readonly id: string;
  readonly root: string;
  readonly persistRoot: string;
  readonly databaseName: string;
  readonly databaseId: string;
  reservePort(): Promise<number>;
  cleanup(): Promise<void>;
}

export async function createE2EIsolation(
  label: string,
  parentRoot?: string,
): Promise<E2EIsolation> {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";
  const resolvedParent = parentRoot ? resolve(parentRoot) : resolve(tmpdir());
  if (parentRoot) assertManagedRoot(resolvedParent);
  await mkdir(resolvedParent, { recursive: true });
  const root = await mkdtemp(join(resolvedParent, `frame-of-mind-e2e-${safeLabel}-`));
  const id = randomUUID().replaceAll("-", "");
  const persistRoot = join(root, "wrangler-state");
  await mkdir(persistRoot, { recursive: true });

  return {
    id,
    root,
    persistRoot,
    databaseName: `fom-e2e-${safeLabel}-${id.slice(0, 12)}`,
    databaseId: randomUUID(),
    reservePort: reserveFreePort,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
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
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  try {
    return await run();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
