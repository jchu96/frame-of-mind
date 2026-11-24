import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { childEnvironment, spawn } from "../lib/child-env.js";

// Only self-contained containers. In particular, never auto-open a playlist,
// image sequence, concat script or external MOV data reference.
export function localVideoInput(formatName?: string) {
  const options = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi"];
  const demuxer = formatName?.split(",")[0];
  // ffmpeg rejects MOV-private options for Matroska/WebM and AVI. Pin their
  // probed demuxer so these reads cannot select MOV without the explicit flag.
  if (demuxer === "matroska" || demuxer === "avi") return [...options, "-f", demuxer];
  return [...options, "-enable_drefs", "0"];
}
export const probeLimit = 32 * 1024 * 1024;
export interface ToolOptions { signal?: AbortSignal; timeoutMs?: number; maxOutput?: number }

export async function runMediaTool(binary: string, args: string[], options: ToolOptions = {}): Promise<string> {
  const { signal, timeoutMs = binary === "ffprobe" ? 60_000 : 600_000, maxOutput = probeLimit } = options;
  signal?.throwIfAborted();
  const prefix = binary === "ffmpeg" ? ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror"]
    : binary === "ffprobe" ? ["-v", "error"] : [];
  const child = spawn(binary, [...prefix, ...args], {
    env: childEnvironment("media"), shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((done, reject) => {
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => fail(new Error("Media operation canceled."));
    const timer = setTimeout(() => fail(new Error(`${binary} timed out.`)), timeoutMs);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutput) fail(new Error(`${binary} output exceeded its scan limit.`));
      else chunks.push(chunk);
    });
    // Any diagnostic at error log level is terminal. Drain but never retain
    // raw stderr, which can contain arbitrary metadata or private pathnames.
    let diagnosticBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      failure ??= new Error(`${binary} reported a media error.`);
      if (diagnosticBytes > 64 * 1024) fail(failure);
    });
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, reason) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || reason) reject(new Error(`${binary} failed (${reason ?? code}).`));
      else done(Buffer.concat(chunks).toString("utf8"));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function sameFile(a: BigIntStats, b: BigIntStats) { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a: BigIntStats, b: BigIntStats) {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
export async function localRecording(input: string) {
  const path = await realpath(resolve(input));
  const identity = await stat(path, { bigint: true });
  if (!identity.isFile()) throw new Error("Input must be a local regular file.");
  async function check() {
    if (await realpath(resolve(input)) !== path || !unchanged(identity, await stat(path, { bigint: true }))) {
      throw new Error("Input recording changed during the operation.");
    }
  }
  return { path, identity, check };
}
export type Recording = Awaited<ReturnType<typeof localRecording>>;

async function targetState(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function stageOutput<T>(
  input: string | Recording, destination: string, extensions: string[], force: boolean, signal: AbortSignal | undefined,
  writeAndVerify: (staged: string) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const recording = typeof input === "string" ? await localRecording(input) : input;
  const parent = await realpath(dirname(resolve(destination)));
  const parentId = await stat(parent, {bigint: true});
  const target = join(parent, basename(destination));
  const ext = extname(target).toLowerCase();
  if (!extensions.includes(ext)) throw new Error(`Destination requires ${extensions.join(" or ")}.`);
  // mkdir is exclusive across processes. A contender fails without ever owning
  // this directory. File creation cannot clobber an outside writer either.
  const lock = join(parent, "." + basename(target) + ".fom-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Lock directory "${lock}" already exists. An interrupted run can leave it behind. It is safe to remove only when no other frameofmind command is writing to this destination.`);
  }
  try {
    const prior = await targetState(target);
    if (prior && !prior.isFile()) throw new Error("Destination must be a regular file and cannot be a link.");
    if (prior && sameFile(prior, recording.identity)) throw new Error("Destination is the input recording.");
    if (prior && !force) throw new Error("Destination exists. Use --force to replace a distinct regular file.");
    const dir = await mkdtemp(join(lock, "stage-"));
    const staged = join(dir, "output" + ext);
    try {
      await (await open(staged, "wx", 0o600)).close();
      await recording.check();
      const result = await writeAndVerify(staged);
      await recording.check();
      if (await realpath(dirname(resolve(destination))) !== parent || !sameFile(parentId, await stat(parent, {bigint: true}))) {
        throw new Error("Destination parent changed.");
      }
      const current = await targetState(target);
      if (prior ? !current || !unchanged(prior, current) : current) throw new Error("Destination changed before publication.");
      signal?.throwIfAborted();
      if (prior) await rename(staged, target);
      else await link(staged, target);
      return result;
    } finally {
      await rm(staged, { force: true });
      await rmdir(dir);
    }
  } finally { await rmdir(lock); }
}
