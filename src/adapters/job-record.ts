import { inJobDirectory, trustedDirectory } from "./job-path.js";
import { randomUUID, createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type * as SQLite from "node:sqlite";
import { z } from "zod";
import { ContractError, faultExits, type FaultCode } from "../domain/contract-error.js";
import type { JobGrant } from "../services/job-grant.js";

const folderName = ".frameofmind-jobs";
const uuid = z.uuid();
const states = z.enum(["queued", "running", "cancelling", "complete", "partial", "failed", "cancelled", "outcome_unknown"]);
const stages = z.enum(["queued", "probe", "upload", "index", "detail", "transcribe", "publish", "cleanup", "finished"]);
const upload = z.object({kind: z.enum(["recording", "audio"]), disposition: z.enum(["not_obtained", "kept", "deleted", "unconfirmed"]),
  expiresAt: z.string().nullable()});
const receipt = z.object({calls: z.number().int(), mediaSeconds: z.number().int(), providerRequests: z.number().int(),
  outputs: z.array(z.string()), uploads: z.array(upload)});
const schema = z.object({
  schemaVersion: z.literal(1), jobId: uuid, requestId: uuid, family: z.enum(["analyze", "transcribe"]),
  selection: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string(), afterUnknown: uuid.optional(),
  limits: z.object({maxMediaSeconds: z.number(), maxProviderRequests: z.number(), maxFileBytes: z.number(),
    allowedModels: z.array(z.string()), retention: z.enum(["provider", "run"])}),
  preparing: z.literal(true).optional(),
  state: states, reason: z.literal("grant_revoked").optional(), stage: stages, percent: z.number().int().min(0).max(100),
  receipt, runFolder: z.string(), runId: z.string().optional(), code: z.enum(Object.keys(faultExits) as [FaultCode, ...FaultCode[]]).optional(),
  grantRevision: z.string().optional(), directoryIdentity: z.string(), resultsIdentity: z.string().optional(), scratchIdentity: z.string().optional(), sealedIdentity: z.string().optional(),
  uncertain: z.boolean(), inputs: z.record(z.string(), z.unknown()), inFlight: z.string().nullable(), cancel: z.object({requested: z.boolean(), steps: z.array(z.string())}),
});
export type JobRecord = z.infer<typeof schema>;
export type Family = JobRecord["family"];
export function active(record: JobRecord) { return ["queued", "running", "cancelling"].includes(record.state); }

function unsafe(): never { throw new ContractError("PATH_OUTSIDE_ROOTS", "Unsafe job storage path."); }
function conflict(): never { throw new ContractError("CONFLICT", "Job storage changed or is busy."); }
function missing(): never { throw new ContractError("JOB_NOT_FOUND", "Unknown job."); }

function plainFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) unsafe();
  return stat;
}
function identity(path: string) {
  const stat = lstatSync(path, {bigint: true});
  return [stat.dev, stat.ino, stat.birthtimeNs].join("/");
}
function privateDirectory(path: string) {
  try { mkdirSync(path, {mode: 0o700}); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  trustedDirectory(path);
  return false;
}
function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// SQLite supplies an OS-released, cross-process lease. The empty database
// contains no records. The JSON file is the authority on every read.
function lease(path: string, wait: boolean) {
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (plainFile(path).size !== 0 || ["-wal", "-shm", "-journal"].some(s => existsSync(path + s))) conflict();
  const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof SQLite | undefined;
  if (!sqlite) throw new ContractError("CAPABILITY_MISSING", "Jobs require the runtime SQLite lock facility.");
  const db = new sqlite.DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=" + (wait ? 5000 : 0));
    db.exec("PRAGMA journal_mode=MEMORY");
    db.exec("BEGIN IMMEDIATE");
    return db;
  } catch (error) {
    db.close();
    if (/database is (locked|busy)/i.test(String(error))) return;
    throw error;
  }
}

// A killed worker can leave a partly rendered bundle. Only remove names the
// two services create under this job's freshly allocated staging directory.
function removeStagedOutputs(root: string, record: JobRecord) {
  const stem = basename(record.selection).replace(/\.[^.]+$/, "");
  const exports = [stem + ".srt", stem + "_speakers.txt", stem + ".transcript.json"];
  const bundle = new Set(["analysis.json", "analysis-outcome.json", "analysis.md", "report.html",
    "manifest.json", "times.json", "failure-manifest.json"]);
  function remove(directory: string, depth: number) {
    trustedDirectory(directory);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isDirectory() && record.family === "analyze") {
        if ((depth === 0 && name === "video-" + record.digest.slice(0, 16)) ||
            (depth === 1 && /^\.?[0-9TZa-f-]+(?:\.staging)?$/.test(name))) remove(path, depth + 1);
      } else if (info.isFile() && info.nlink === 1) {
        if (depth === 2 && bundle.has(name) || record.family === "transcribe" && depth === 0 &&
          exports.some(target => name === target || name.startsWith(target + ".partial-") &&
            uuid.safeParse(name.slice((target + ".partial-").length)).success)) unlinkSync(path);
      }
    }
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  }
  remove(root, 0);
}

export class JobStore {
  readonly root: string;
  private readonly identity: {dev: number; ino: number};

  constructor(readonly out: string, create: boolean, private readonly grantRevision?: string) {
    trustedDirectory(out);
    this.root = join(out, folderName);
    const created = create && privateDirectory(this.root);
    if (!existsSync(this.root)) missing();
    const marker = join(this.root, ".frameofmind-owner");
    if (created) {
      writeFileSync(marker, identity(this.root), {flag: "wx", mode: 0o600});
      syncDirectory(this.root);
      syncDirectory(out);
    } else {
      if (!existsSync(marker)) conflict();
      plainFile(marker);
      if (readFileSync(marker, "utf8") !== identity(this.root)) conflict();
    }
    trustedDirectory(this.root);
    this.identity = statSync(this.root);
  }

  check() {
    trustedDirectory(this.root);
    const current = statSync(this.root);
    if (current.dev !== this.identity.dev || current.ino !== this.identity.ino) conflict();
  }

  directory(id: string) {
    if (!uuid.safeParse(id).success) throw new ContractError("BAD_ARGUMENTS", "Expected a job UUID.");
    return join(this.root, id);
  }

  locked<T>(fn: () => T): T {
    this.check();
    const lock = inJobDirectory(this.root, () => lease(".admission", true));
    if (!lock) conflict();
    try { return fn(); } finally { lock.close(); }
  }

  worker(id: string) {
    const directory = this.directory(id);
    trustedDirectory(directory);
    return inJobDirectory(directory, () => lease(".worker", false));
  }

  save(record: JobRecord) {
    this.check();
    const directory = this.directory(record.jobId);
    trustedDirectory(directory);
    if (identity(directory) !== record.directoryIdentity) conflict();
    inJobDirectory(directory, () => {
      const target = "job.json";
      if (existsSync(target)) plainFile(target);
      const pending = ".job-" + randomUUID();
      const fd = openSync(pending, "wx", 0o600);
      try {
        try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); }
        finally { closeSync(fd); }
        renameSync(pending, target);
        syncDirectory(".");
      } finally { rmSync(pending, {force: true}); }
    });
  }

  load(id: string, family?: Family): JobRecord {
    this.check();
    const dir = this.directory(id);
    if (!existsSync(dir)) missing();
    trustedDirectory(dir);
    const path = join(dir, "job.json");
    if (!existsSync(path)) missing();
    const info = plainFile(path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let raw;
    try {
      const current = fstatSync(fd);
      if (current.dev !== info.dev || current.ino !== info.ino || !current.isFile()) conflict();
      raw = JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
    if (raw.schemaVersion !== 1) throw new ContractError("UNKNOWN_SCHEMA", "Unsupported job record.");
    const record = schema.parse(raw);
    if (record.jobId !== id || (family && record.family !== family)) missing();
    if (record.directoryIdentity !== identity(dir)) conflict();
    if (resolve(record.runFolder) !== record.runFolder || (record.runFolder !== dir && !record.runFolder.startsWith(dir + sep))) unsafe();
    if (existsSync(record.runFolder)) trustedDirectory(record.runFolder);
    if (active(record) && existsSync(join(dir, "cancel.request"))) {
      record.state = "cancelling";
      record.cancel.requested = true;
    }
    return record;
  }

  recover(record: JobRecord) {
    if (!active(record)) return record;
    const lock = this.worker(record.jobId);
    if (!lock) return record;
    try {
      // The caller holds the admission lock. A new holder of the worker
      // lease proves that this job has no worker, even after PID reuse.
      record = this.load(record.jobId);
      if (!active(record)) return record;
      // When the worker cannot write its final record after revocation, the
      // journal may still say queued. Only an uninterrupted grant proves
      // ordinary unsent cancellation in that case.
      const changedGrant = record.grantRevision !== undefined && record.grantRevision !== this.grantRevision;
      if (changedGrant) delete record.preparing;
      const uncertain = record.receipt.providerRequests > 0 || changedGrant;
      record.state = uncertain ? "outcome_unknown" : "cancelled";
      record.code = uncertain ? "OUTCOME_UNKNOWN" : "CANCELLED";
      if (!record.receipt.uploads.some(upload => upload.disposition !== "not_obtained")) record.receipt.mediaSeconds = 0;
      record.cancel.steps.push("worker stopped", ...this.cleanScratch(record));
      this.save(record);
      return record;
    } finally { lock.close(); }
  }

  cleanScratch(record: JobRecord) {
    this.check();
    const dir = this.directory(record.jobId);
    trustedDirectory(dir);
    if (identity(dir) !== record.directoryIdentity) conflict();
    const path = join(dir, "scratch");
    if (!existsSync(path)) return [];
    trustedDirectory(path);
    if (identity(path) !== record.scratchIdentity) return ["scratch ownership unconfirmed"];
    const sealed = basename(record.selection);
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (name === sealed && identity(child) === record.sealedIdentity && plainFile(child).nlink === 1) {
        unlinkSync(child);
      } else if (name === "results" && identity(child) === record.resultsIdentity) {
        removeStagedOutputs(child, record);
      } else if (/^(?:frame-of-mind-|fom-transcribe-)[A-Za-z0-9]{6}$/.test(name)) {
        // Only the empty analyze scratch or named AAC derivatives belong to
        // the worker. A foreign file in that directory must survive recovery.
        trustedDirectory(child);
        const owner = join(child, ".frameofmind-owner.json");
        if (!existsSync(owner)) continue;
        plainFile(owner);
        const marker = JSON.parse(readFileSync(owner, "utf8"));
        if (marker.directory !== identity(child) || marker.name !== name || marker.kind !== record.family) continue;
        for (const item of readdirSync(child)) {
          if (marker.kind === "transcribe" && /^audio-[1-9][0-9]*\.aac$/.test(item)) {
            const audio = join(child, item);
            plainFile(audio);
            unlinkSync(audio);
          }
        }
        if (readdirSync(child).length === 1) { unlinkSync(owner); rmdirSync(child); }
      }
    }
    if (readdirSync(path).length) return ["preserved unverified scratch entries"];
    rmdirSync(path);
    return ["removed owned scratch"];
  }

  createResults(record: JobRecord) {
    this.check();
    const scratch = join(this.directory(record.jobId), "scratch");
    trustedDirectory(scratch);
    if (identity(scratch) !== record.scratchIdentity) conflict();
    const results = join(scratch, "results");
    inJobDirectory(scratch, () => mkdirSync("results", {mode: 0o700}));
    record.resultsIdentity = identity(results);
    this.save(record);
  }

  createScratch(record: JobRecord) {
    const directory = this.directory(record.jobId);
    this.check();
    trustedDirectory(directory);
    if (identity(directory) !== record.directoryIdentity) conflict();
    const scratch = join(directory, "scratch");
    inJobDirectory(directory, () => mkdirSync("scratch", {mode: 0o700}));
    record.scratchIdentity = identity(scratch);
    this.save(record);
    return scratch;
  }

  admit(family: Family, requestId: string, selection: string, digest: string, normalized: object, grant: JobGrant,
    seconds: number, afterUnknown?: string) {
    const signature = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    return this.locked(() => {
      const records = readdirSync(this.root).filter(id => uuid.safeParse(id).success && existsSync(join(this.directory(id), "job.json")))
        .map(id => this.load(id))
        .filter(record => record.requestId === requestId || record.digest === digest)
        .map(record => this.recover(record));
      const prior = records.find(record => record.requestId === requestId);
      if (prior) {
        if (prior.digest !== digest || prior.signature !== signature) throw new ContractError("REQUEST_CONFLICT", "This request ID already has different inputs.");
        return {record: prior};
      }
      const replaced = new Set(records.map(record => record.afterUnknown));
      const unknown = records.find(record => record.state === "outcome_unknown" && record.digest === digest && !replaced.has(record.jobId));
      if (unknown?.jobId !== afterUnknown) throw new ContractError("UNKNOWN_JOB_REQUIRED", "Name the matching uncertain job.");
      const id = randomUUID();
      const dir = this.directory(id);
      inJobDirectory(this.root, () => mkdirSync(id, {mode: 0o700}));
      const worker = this.worker(id);
      if (!worker) conflict();
      const {read: _read, write: _write, ...limits} = grant;
      const record: JobRecord = {schemaVersion: 1, jobId: id, requestId, family, selection, digest, signature,
        limits, preparing:true, grantRevision: this.grantRevision, directoryIdentity: identity(dir), uncertain: false, inputs: {...normalized}, afterUnknown, state: "queued", stage: "queued", percent: 0, inFlight: null, runFolder: dir,
        cancel: {requested: false, steps: []}, receipt: {calls: 1, mediaSeconds: Math.ceil(seconds), providerRequests: 0, outputs: [], uploads: []}};
      try { this.save(record); syncDirectory(this.root); }
      catch (error) { worker.close(); throw error; }
      return {record, worker};
    });
  }
}
