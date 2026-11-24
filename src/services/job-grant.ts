import { closeSync, constants, fstatSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openJobFile, trustedDirectory } from "../adapters/job-path.js";
import { z } from "zod";
import { geminiModelSchema } from "../adapters/gemini-model.js";
import { ContractError, MissingJobArgumentError, faultCode } from "../domain/contract-error.js";
import { MAX_RECORDING_BYTES } from "../lib/files.js";

const rootDocument = z.strictObject({schemaVersion: z.literal(1), read: z.array(z.string()), write: z.array(z.string())});
// Changing or replacing the roots document leaves evidence for recovery even
// when a revoked worker could not persist its own terminal record. A symbol
// keeps this revision out of normalized request arguments and replay signatures.
export const rootsRevision = Symbol("roots document revision");
type Roots = Pick<z.infer<typeof rootDocument>, "read" | "write"> & {[rootsRevision]?: string};
export type JobGrant = Roots & {
  maxMediaSeconds: number;
  maxProviderRequests: number;
  maxFileBytes: number;
  allowedModels: string[];
  retention: "provider" | "run";
};
export type JobFile = {root: string; path: string};

function usage(): never { throw new ContractError("USAGE", "Supply all required job grant flags."); }
function outside(): never { throw new ContractError("PATH_OUTSIDE_ROOTS", "Path is outside the grant."); }
function invalidRoots(): never { throw new ContractError("ROOTS_INVALID", "Invalid roots file."); }
function limit(raw: unknown) {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) usage();
  return Number(raw);
}

export function inside(root: string, path: string) {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
}
export function checkJobDirectory(path: string, selectedOut: boolean) {
  if (!isAbsolute(path) || path !== resolve(path) || (process.platform === "win32" && !/^[a-z]:\\[^:]*$/i.test(path))) outside();
  try {
    trustedDirectory(path);
  } catch (error) {
    if (selectedOut && faultCode(error) === "NOT_FOUND") throw new MissingJobArgumentError("out");
    outside();
  }
}
async function fromFile(path: string): Promise<Roots> {
  if (!isAbsolute(path) || resolve(path) !== path) invalidRoots();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ELOOP") invalidRoots();
      throw new ContractError(error.code === "ENOENT" ? "ROOTS_MISSING" : "ROOTS_UNREADABLE", "Cannot open the roots file.");
    });
  try {
    const held = await file.stat({bigint: true});
    if (!held.isFile() || held.nlink !== 1n || await realpath(path) !== path) invalidRoots();
    if (process.getuid && (held.uid !== 0n && held.uid !== BigInt(process.getuid()) || (held.mode & 0o022n) !== 0n)) invalidRoots();
    try { trustedDirectory(dirname(path), Number(held.uid)); } catch { invalidRoots(); }
    const raw = await file.readFile("utf8").catch(() => { throw new ContractError("ROOTS_UNREADABLE", "Cannot read the roots file."); });
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { invalidRoots(); }
    const grant = rootDocument.safeParse(parsed);
    if (!grant.success) invalidRoots();
    const {read, write} = grant.data;
    if (!read.length && !write.length) throw new ContractError("ROOTS_EMPTY", "The file grants no directories.");
    if ([...read, ...write].some(dir => !isAbsolute(dir) || resolve(dir) !== dir || inside(dir, path))) invalidRoots();
    const revision = [held.dev, held.ino, held.ctimeNs].join("/");
    return {read, write, [rootsRevision]: revision};
  } finally { await file.close(); }
}

export async function readJobRoots(values: Record<string, unknown>): Promise<Roots> {
  let roots: Roots;
  if (values.rootsFile !== undefined) {
    if (typeof values.rootsFile !== "string" || values.mediaRoot !== undefined || values.outputRoot !== undefined) usage();
    roots = await fromFile(values.rootsFile);
  } else {
    const list = z.array(z.string().min(1)).min(1);
    const read = list.safeParse(values.mediaRoot);
    const write = list.safeParse(values.outputRoot);
    if (!read.success || !write.success) usage();
    roots = {read: read.data, write: write.data};
  }
  const out = typeof values.out === "string" ? resolve(values.out) : undefined;
  for (const root of [...roots.read, ...roots.write]) checkJobDirectory(root, root === out && roots.write.includes(root));
  return {...roots, read: [...new Set(roots.read)].sort(), write: [...new Set(roots.write)].sort()};
}

export async function readJobGrant(values: Record<string, unknown>): Promise<JobGrant> {
  const maxMediaSeconds = limit(values.maxMediaSeconds);
  const maxProviderRequests = limit(values.maxProviderRequests);
  const maxFileBytes = limit(values.maxFileBytes);
  const retention = values.retention;
  if (maxFileBytes > MAX_RECORDING_BYTES || (retention !== "provider" && retention !== "run")) usage();
  if (typeof values.allowedModels !== "string") usage();
  const allowedModels = values.allowedModels.split(",");
  if (!allowedModels.every(id => geminiModelSchema.safeParse(id).success)) usage();
  return {...await readJobRoots(values), maxMediaSeconds, maxProviderRequests, maxFileBytes, allowedModels, retention};
}

export async function openJobInput(grant: JobGrant, file: JobFile, out: string) {
  if (!grant.read.includes(file.root) || !grant.write.some(dir => inside(dir, out)) || !isAbsolute(out)) outside();
  checkJobDirectory(out, true);
  const components = file.path.split("/");
  if (Buffer.byteLength(file.path) > 1024 || components.some(name =>
    !name || /[. ]$|[\\:\x00-\x1f\x7f]/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) outside();
  const path = join(file.root, ...components);
  trustedDirectory(dirname(path));
  if (await realpath(path) !== path) outside();
  const before = await lstat(path, {bigint: true});
  if (!before.isFile() || before.nlink !== 1n) outside();
  if (!/\.(mp4|m4v|mov|webm)$/i.test(path)) throw new ContractError("INVALID_INPUT", "Expected a local video container.");
  const fd = openJobFile(path, constants.O_RDONLY);
  try {
    const held = fstatSync(fd, {bigint: true});
    if (held.dev !== before.dev || held.ino !== before.ino) outside();
    if (held.size > BigInt(grant.maxFileBytes)) throw new ContractError("FILE_LIMIT", "Recording exceeds the file grant.");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
