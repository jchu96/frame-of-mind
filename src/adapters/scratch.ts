import { ContractError } from "../domain/contract-error.js";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { z } from "zod";

const prefixes = {
  range: "fom-range-", analyze: "frame-of-mind-", transcribe: "fom-transcribe-", calibration: "frame-of-mind-calibration-",
  screenshots: ".settled-",
};
type Kind = keyof typeof prefixes | "media-lock";
export const markerName = ".frameofmind-owner.json";
const instance = randomUUID();
const schema = z.object({
  version: z.literal(1), kind: z.string(), name: z.string(), directory: z.string(), host: z.string(),
  pid: z.number().int().positive().max(0x7fffffff), instance: z.uuid(),
  stage: z.object({name: z.string().regex(/^stage-[A-Za-z0-9]{6}$/), directory: z.string()}).optional(),
  start: z.string().regex(/^[a-f0-9-]{36}\/\d+$/).nullable(), namespace: z.string().nullable(),
});
type Marker = z.infer<typeof schema>;

function identity(s: BigIntStats) { return [s.dev, s.ino, s.birthtimeNs].join("/"); }

// Linux exposes kernel start ticks. Node has no equivalent foreign-process
// birth query on macOS or Windows. A positive PID lookup alone cannot prove
// death there, so keep the directory when the PID might have been recycled.
async function processStart(pid: number) {
  if (process.platform !== "linux") return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!ticks || !/^\d+$/.test(ticks)) return null;
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return boot + "/" + ticks;
  } catch { return null; }
}

async function pidNamespace() {
  return process.platform === "linux" ? readlink("/proc/self/ns/pid").catch(() => null) : null;
}

async function mark(path: string, kind: Kind, stage?: string) {
  const marker: Marker = {
    version: 1, kind, name: basename(path), directory: identity(await lstat(path, {bigint: true})),
    stage: stage ? {name: basename(stage), directory: identity(await lstat(stage, {bigint: true}))} : undefined,
    host: hostname(), pid: process.pid, instance, start: await processStart(process.pid), namespace: await pidNamespace(),
  };
  await writeFile(join(path, markerName), JSON.stringify(marker), {flag: "wx", mode: 0o600});
}

export async function createScratch(kind: keyof typeof prefixes, parent = tmpdir()) {
  const path = await mkdtemp(join(parent, prefixes[kind]));
  try { await mark(path, kind); }
  catch (error) { await rm(path, {recursive: true, force: true}); throw error; }
  return path;
}

export async function createMediaLock(path: string) {
  await mkdir(path, {mode: 0o700});
  let stage: string | undefined;
  try {
    stage = await mkdtemp(join(path, "stage-"));
    await mark(path, "media-lock", stage);
    return stage;
  } catch (error) { await releaseMediaLock(path, stage); throw error; }
}

export async function releaseMediaLock(path: string, stage?: string) {
  if (stage) await rmdir(stage);
  await rm(join(path, markerName), {force: true});
  await rmdir(path);
}

// The marker names the private directory. This receipt also pins the payload
// inode and the encoder that may outlive its parent after a hard crash.
const encoderReceipt = ".range-encoder.json";
export function rangeEncoder(path: string) {
  const directory = dirname(path);
  const file = identity(lstatSync(path, { bigint: true }));
  const receipt = join(directory, encoderReceipt);
  writeFileSync(receipt, JSON.stringify({ name: basename(path), file, pid: null }), { flag: "wx", mode: 0o600 });
  const stamp = identity(lstatSync(receipt, {bigint: true}));
  return (pid: number) => {
    const fd = openSync(receipt, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (identity(fstatSync(fd, {bigint: true})) !== stamp) throw new Error("Encoder receipt changed");
      // Fixed-width PID text keeps this update a single write with no stale suffix.
      const record = JSON.stringify({ name: basename(path), file, pid }).padEnd(512);
      writeFileSync(fd, record);
    } finally { closeSync(fd); }
  };
}

function safeRangeContents(path: string, payload: string[], abandoned: boolean) {
  if (!payload.length) return;
  const receipt = join(path, encoderReceipt);
  const meta = lstatSync(receipt);
  if (!meta.isFile() || meta.nlink !== 1 || meta.size > 1024) throw new Error("Unknown encoder receipt");
  const value = JSON.parse(readFileSync(receipt, "utf8")) as { name: string; file: string; pid: number | null };
  if (!/^cut\.(mp4|wav)$/.test(value.name) || payload.some(name => name !== value.name && name !== encoderReceipt)) {
    throw new Error("Unknown range files");
  }
  if (payload.includes(value.name)) {
    const file = lstatSync(join(path, value.name), {bigint: true});
    if (!file.isFile() || file.nlink !== 1n || identity(file) !== value.file) throw new Error("Changed range file");
  }
  if (abandoned) {
    if (!Number.isInteger(value.pid) || value.pid! <= 0 || value.pid! > 0x7fffffff) throw new Error("Unconfirmed encoder");
    try { process.kill(value.pid!, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    throw new Error("Encoder may be live");
  }
}

function match(name: string, local: boolean): Kind | undefined {
  if (local && /^\..+\.fom-lock$/s.test(name)) return "media-lock";
  for (const [kind, prefix] of Object.entries(prefixes)) {
    if ((kind === "screenshots") === local && name.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length))) {
      return kind as keyof typeof prefixes;
    }
  }
}

async function owner(path: string, kind: Kind, directory: BigIntStats) {
  const file = join(path, markerName);
  const before = await lstat(file, {bigint: true});
  if (!before.isFile() || before.nlink !== 1n || before.size > 2048n || before.uid !== directory.uid) return;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat({bigint: true});
    if (identity(info) !== identity(before) || !info.isFile()) return;
    const buffer = Buffer.alloc(2049);
    const {bytesRead} = await handle.read(buffer);
    const marker = schema.parse(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
    if (directory.ino !== 0n && marker.kind === kind && marker.name === basename(path) &&
        marker.directory === identity(directory)) return {marker, file: identity(info), modified: info.mtimeNs};
  } finally { await handle.close(); }
}

async function ownerState(marker: Marker) {
  if (marker.host !== hostname()) return "unknown owner" as const;
  if (process.platform === "linux" && (!marker.namespace || marker.namespace !== await pidNamespace())) return "unknown owner";
  if (marker.pid === process.pid) return marker.instance === instance ? "live" : "unknown owner";
  try { process.kill(marker.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "abandoned" : "unknown owner"; }
  const start = await processStart(marker.pid);
  if (start && marker.start) return start === marker.start ? "live" : "abandoned";
  return "live or reused PID";
}

type State = Awaited<ReturnType<typeof ownerState>> | "unproven";
interface Row { kind: Kind; path: string; size: number | null; ageMs: number | null; state: State; removed: boolean; reason?: string }

const stageName = /^stage-[a-zA-Z0-9]{6}$/;

// All scratch is flat except the media lock's stage directory. Do not
// recurse into an arbitrary user tree to size an old, unproven folder.
async function sizeOf(path: string, device: bigint, allowStage: boolean): Promise<number | null> {
  if (await realpath(path) !== path) return null;
  let bytes = 0;
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const info = await lstat(child, {bigint: true});
    if (info.dev !== device) return null;
    if (info.isDirectory()) {
      if (!allowStage || !stageName.test(name)) return null;
      const nested = await sizeOf(child, device, false);
      if (nested === null) return null;
      bytes += nested;
    } else { bytes += Number(info.size); }
  }
  return bytes;
}

const payloadNames = {
  analyze: /^(?:recording\.(?:webm|mp4|m4v|mov|mp3)|derived-audio-\d+\.aac|still-\d+-\d+\.png)$/i,
  transcribe: /^audio-\d+\.aac$/, screenshots: /^frame-\d{3}\.png$/, calibration: /^flash\.mp4$/,
};

// Only the media lock has a subdirectory. Pin each directory as the working
// directory before unlinking basenames. A rename or symlink substitution at
// the original path cannot redirect an unlink through an ancestor. Keep this
// CLI-only section synchronous and restore cwd before yielding to any caller.
function removeContents(path: string, kind: Kind, directory: BigIntStats, proof: NonNullable<Awaited<ReturnType<typeof owner>>>, abandoned = true) {
  const previous = process.cwd();
  const parent = dirname(path);
  if (previous === path || previous.startsWith(path + sep)) throw new Error("Current working directory");
  const parentId = identity(lstatSync(parent, {bigint: true}));
  function verifyDirectory(expected: string, id: string) {
    if (realpathSync(".") !== expected || identity(lstatSync(".", {bigint: true})) !== id) {
      throw new Error("Directory changed");
    }
  }
  function enter(name: string, expected: string, id: string) {
    const current = lstatSync(name, {bigint: true});
    if (!current.isDirectory() || identity(current) !== id || current.dev !== directory.dev) throw new Error("Directory changed");
    process.chdir(name);
    verifyDirectory(expected, id);
  }
  try {
    enter(path, path, identity(directory));
    const mark = lstatSync(markerName, {bigint: true});
    if (!mark.isFile() || identity(mark) !== proof.file || mark.mtimeNs !== proof.modified) throw new Error("Marker changed");
    const payload = readdirSync(".").filter(name => name !== markerName);
    if (kind === "media-lock" && payload.length) {
      const stage = proof.marker.stage;
      if (!stage || payload.length !== 1 || payload[0] !== stage.name) throw new Error("Unexpected lock contents");
      enter(stage.name, join(path, stage.name), stage.directory);
      const files = readdirSync(".");
      const output = "output" + extname(basename(path, ".fom-lock")).toLowerCase();
      if (files.some(name => name !== output || !lstatSync(name).isFile())) throw new Error("Unexpected stage contents");
      for (const file of files) unlinkSync(file);
      enter("..", path, identity(directory));
      if (identity(lstatSync(stage.name, {bigint: true})) !== stage.directory) throw new Error("Stage changed");
      rmdirSync(stage.name);
    } else if (kind === "range") {
      safeRangeContents(".", payload, abandoned);
      for (const name of payload.filter(name => name !== encoderReceipt)) unlinkSync(name);
      if (payload.includes(encoderReceipt)) unlinkSync(encoderReceipt);
    } else if (kind !== "media-lock") {
      const pattern = payloadNames[kind];
      if (payload.some(name => !pattern.test(name) || !lstatSync(name).isFile())) throw new Error("Unexpected scratch contents");
      for (const file of payload) unlinkSync(file);
    }
    unlinkSync(markerName);
    enter("..", parent, parentId);
    const name = basename(path);
    if (identity(lstatSync(name, {bigint: true})) !== identity(directory)) throw new Error("Directory changed");
    rmdirSync(name);
  } finally { process.chdir(previous); }
}

async function inspect(path: string, kind: Kind, remove: boolean): Promise<Row> {
  const row: Row = {kind, path, size: null, ageMs: null, state: "unproven", removed: false};
  try {
    const info = await lstat(path, {bigint: true});
    row.ageMs = Math.max(0, Date.now() - Number(info.birthtimeMs || info.mtimeMs));
    row.size = Number(info.size);
    if (!info.isDirectory() || await realpath(path) !== path) return {...row, reason: "link or non-directory"};
    row.size = await sizeOf(path, info.dev, kind === "media-lock");
    if (process.getuid && info.uid !== BigInt(process.getuid())) return {...row, reason: "different filesystem owner"};
    const proof = await owner(path, kind, info).catch(() => undefined);
    if (!proof) return {...row, reason: "missing or invalid marker"};
    row.state = await ownerState(proof.marker);
    if (!remove || row.state !== "abandoned") return row;
    if (row.size === null) return {...row, reason: "unexpected directory or filesystem boundary"};
    removeContents(path, kind, info, proof);
    row.removed = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    row.reason = code ? `could not inspect or remove (${code})` : "scratch identity or contents could not be verified";
  }
  return row;
}

// With an explicit directory inspect only adjacent scratch. Resolve the OS
// temp alias (e.g. /var on macOS), but refuse symlinked operator scan roots.
export async function inspectScratch(directory?: string, remove?: string): Promise<Row[]> {
  const selected = resolve(directory ?? tmpdir());
  const root = await realpath(selected);
  const systemAlias = directory === undefined && process.platform === "darwin" &&
    /^\/(?:var|tmp)(?:\/|$)/.test(selected) && root === "/private" + selected;
  if (root !== selected && !systemAlias) {
    throw new ContractError("PATH_OUTSIDE_ROOTS", "Choose the real directory path for the scratch scan.");
  }
  const rows: Row[] = [];
  for (const name of (await readdir(root)).sort()) {
    const kind = match(name, directory !== undefined);
    const path = join(root, name);
    if (kind) rows.push(await inspect(path, kind, remove !== undefined && resolve(remove) === path));
  }
  return rows;
}

export async function releaseRangeScratch(path: string) {
  const real = await realpath(path);
  const info = await lstat(real, {bigint: true});
  const proof = await owner(real, "range", info);
  if (!proof || proof.marker.instance !== instance) throw new Error("Changed range scratch directory");
  removeContents(real, "range", info, proof, false);
}

export async function reapRangeScratch() {
  const root = await realpath(tmpdir());
  for (const name of await readdir(root)) {
    if (match(name, false) === "range") await inspect(join(root, name), "range", true);
  }
}

export function discardRangeAttempt(file: string) {
  const root = dirname(file);
  const files = readdirSync(root).filter(entry => entry !== markerName);
  safeRangeContents(root, files, false);
  if (files.includes(basename(file))) unlinkSync(file);
  unlinkSync(join(root, encoderReceipt));
}
