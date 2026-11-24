import { providerFailureCode } from "../adapters/gemini-error-class.js";
import { basename, join, relative, resolve, sep } from "node:path";
import { closeSync, constants, existsSync, fstatSync, readdirSync, renameSync, writeFileSync, watch } from "node:fs";
import { inJobDirectory, openJobFile, trustedDirectory } from "../adapters/job-path.js";
import { z } from "zod";
import { active, JobStore, type Family, type JobRecord } from "../adapters/job-record.js";
import type { JobDispatch } from "../adapters/job-provider-transport.js";
import { ContractError, MissingJobArgumentError, faultCode } from "../domain/contract-error.js";
import { snapSettings } from "../domain/snap.js";
import { listBuiltInRecipes, loadRecipe, withAnalysisDepth } from "../recipes/index.js";
import { checkJobDirectory, inside, openJobInput, readJobGrant, readJobRoots, rootsRevision, type JobGrant } from "./job-grant.js";
import { digestJobMedia, probeJobMedia } from "./job-media.js";
import type { ThinkingLevel } from "../domain/types.js";
import type { TranscribeDependencies } from "./transcribe.js";

export type JobOperation = "start" | "status" | "result" | "cancel" | "dry-run";
export interface JobOptions extends Record<string, unknown> {
  thinkingLevel?: ThinkingLevel;
  out: string; recipe?: string; model?: string; snap?: string; transcriptJson?: boolean; requestId?: string; afterUnknown?: string;
}
export interface JobDependencies {
  probe?: typeof probeJobMedia;
  extractAudioTrack?: TranscribeDependencies["extractAudioTrack"];
  sleep?: TranscribeDependencies["sleep"];
}
function document(record: JobRecord) {
  const {jobId, state, stage, percent, code, reason, runId, receipt} = record;
  return {jobId, state, stage, percent, ...(code && {code}), ...(reason && {reason}), ...(runId && {runId}), ...(!active(record) && {receipt}),
    ...(record.cancel.requested && {cancel: record.cancel})};
}
function checkOut(roots: {write: string[]}, out: string) {
  if (!roots.write.some(root => inside(root, out))) throw new ContractError("PATH_OUTSIDE_ROOTS", "Output outside the grant.");
  checkJobDirectory(out, true);
}
function markCancel(directory: string) {
  const marker = join(directory, "cancel.request");
  try { writeFileSync(marker, "", {flag: "wx", mode: 0o600}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
function lookup(store: JobStore, family: Family, id: string, op: JobOperation) {
  return store.locked(() => {
    const record = store.recover(store.load(id, family));
    if (op === "result") {
      const {jobId, runId, runFolder, receipt} = record;
      if (active(record)) throw new ContractError("JOB_PENDING", "The job is still active.");
      if (record.code) throw new ContractError(record.code, "Job failed.", {jobId, runFolder, receipt});
      return {receipt, runFolder, ...(runId && {runId})};
    }
    if (op === "cancel") {
      if (active(record)) {
        markCancel(store.directory(id));
        record.state = "cancelling";
      }
      if (!record.cancel.requested) {
        record.cancel.requested = true;
        record.cancel.steps.push(active(record) ? "requested worker stop" : "worker already stopped");
        if (!active(record)) store.save(record);
      }
    }
    return document(record);
  });
}

export async function runJob(family: Family, op: JobOperation, arg: string, flags: JobOptions,
  admit: (data: object) => Promise<void>, deps: JobDependencies = {}) {
  const out = resolve(flags.out);
  if (op !== "start" && op !== "dry-run") {
    const current = await readJobRoots(flags);
    checkOut(current, out);
    return lookup(new JobStore(out, false, current[rootsRevision]), family, arg, op);
  }
  const grant = await readJobGrant(flags);
  checkOut(grant, out);
  const model = flags.model ?? grant.allowedModels[0]!;
  if (!grant.allowedModels.includes(model)) throw new ContractError("MODEL_DENIED", "Model outside grant.");
  if (family === "analyze" && !listBuiltInRecipes().some(x => x.id === flags.recipe)) {
    throw new ContractError("BAD_ARGUMENTS", "Expected a built-in recipe.");
  }
  if (flags.snap !== undefined && flags.snap !== "speech") throw new ContractError("BAD_ARGUMENTS", "Expected speech snap.");
  if (op === "start" && (!z.uuid().safeParse(flags.requestId).success ||
      (flags.afterUnknown !== undefined && !z.uuid().safeParse(flags.afterUnknown).success))) {
    throw new ContractError("BAD_ARGUMENTS", "Expected a UUID.");
  }
  if (arg.split(/[\\/]/).some(part => part === "..")) throw new ContractError("PATH_OUTSIDE_ROOTS", "Parent traversal.");
  const selection = resolve(arg);
  const mediaRoot = grant.read.find(root => inside(root, selection));
  if (!mediaRoot) throw new ContractError("PATH_OUTSIDE_ROOTS", "Recording outside the grant.");
  const file = await openJobInput(grant, {root: mediaRoot, path: relative(mediaRoot, selection).split(sep).join("/")}, out)
    .catch(error => {
      if (faultCode(error) === "NOT_FOUND" && !(error instanceof MissingJobArgumentError)) throw new MissingJobArgumentError("file");
      throw error;
    });
  try {
    const before = fstatSync(file, {bigint: true});
    const bytes = Number(before.size);
    const seconds = await (deps.probe ?? probeJobMedia)(file);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new ContractError("INVALID_INPUT", "Expected positive recording duration.");
    if (Math.ceil(seconds) > grant.maxMediaSeconds) throw new ContractError("MEDIA_LIMIT", "Recording exceeds the duration grant.");
    if (fstatSync(file, {bigint: true}).ctimeNs !== before.ctimeNs) throw new ContractError("CONFLICT", "Recording changed.");
    if (op === "dry-run") return {file: selection, bytes, seconds, model, retention: grant.retention};
    const digest = await digestJobMedia(file, bytes);
    if (fstatSync(file, {bigint: true}).ctimeNs !== before.ctimeNs) throw new ContractError("CONFLICT", "Recording changed.");
    const normalized = {family, file: selection, model, recipe: flags.recipe, snap: flags.snap, transcriptJson: !!flags.transcriptJson,
      ...(flags.thinkingLevel && {thinkingLevel: flags.thinkingLevel}),
      afterUnknown: flags.afterUnknown, rootsFile: flags.rootsFile, out, grant};
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) throw new ContractError("KEY_MISSING", "Job start requires a provider credential.");
    const current = await readJobRoots(flags);
    checkOut(current, out);
    if (!current.read.includes(mediaRoot)) throw new ContractError("PATH_OUTSIDE_ROOTS", "The media grant changed.");
    const store = new JobStore(out, true, current[rootsRevision]);
    const {record, worker} = store.admit(family, flags.requestId!, selection, digest, normalized, grant, seconds, flags.afterUnknown);
    if (!worker) return document(record);
    const signal = new AbortController();
    const cancel = () => {
      signal.abort();
      try { markCancel(store.directory(record.jobId)); } catch { /* An inaccessible job may only stop. */ }
    };
    // The caller can interrupt as soon as it reads the admission document.
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      await admit(document(record));
      await execute(store, record, flags, grant, model, key, seconds, deps, signal, async path => {
        if (await digestJobMedia(file, bytes, path, identity => { record.sealedIdentity = identity; store.save(record); }) !== digest) throw new ContractError("CONFLICT", "Recording changed during sealing.");
      });
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      worker.close();
    }
    return;
  } finally { closeSync(file); }
}

async function execute(store: JobStore, record: JobRecord, flags: JobOptions, grant: JobGrant, model: string, key: string,
  seconds: number, deps: JobDependencies, signal: AbortController, seal: (path: string) => Promise<void>) {
  const directory = store.directory(record.jobId);
  const scratch = join(directory, "scratch");
  const refreshCancel = () => {
    if (existsSync(join(directory, "cancel.request"))) signal.abort();
  };
  const save = () => store.save(record);
  const stage = (name: JobRecord["stage"], percent: number) => {
    record.stage = name;
    record.percent = Math.max(percent, record.percent);
    save();
  };
  let revoked = false;
  const authorize = async (op?: JobDispatch) => {
    try {
      if (!revoked) {
        const current = await readJobRoots(flags);
        checkOut(current, store.out);
        if (!current.read.some(root => inside(root, record.selection))) revoked = true;
      }
    } catch { revoked = true; }
    if (revoked) {
      signal.abort();
      if (op !== "delete" || grant.retention !== "run") throw new ContractError("CANCELLED", "Job grant revoked.");
    }
    store.check();
    trustedDirectory(directory);
    refreshCancel();
    if (op !== "delete" && signal.signal.aborted) throw new ContractError("CANCELLED", "Job cancelled.");
  };
  const sealed = join(scratch, basename(record.selection));
  let generation = 0;
  const {receipt} = record;
  const {JobProviderTransport} = await import("../adapters/job-provider-transport.js");
  const transport = new JobProviderTransport(grant.maxProviderRequests, grant.maxFileBytes, grant.retention, (op, count) => {
    refreshCancel();
    if (op !== "delete" && signal.signal.aborted) throw new ContractError("CANCELLED", "Job cancelled.");
    record.inFlight = op;
    receipt.providerRequests = count;
    if (op === "start") receipt.uploads.push({kind: record.family === "analyze" ? "recording" : "audio", disposition: "not_obtained", expiresAt: null});
    if (op === "finalize") receipt.uploads.at(-1)!.disposition = "unconfirmed";
    if (op === "generate") generation++;
    const name = op === "delete" ? "cleanup" : op !== "generate" ? "upload" :
      record.family === "transcribe" ? "transcribe" : generation === 1 ? "index" : "detail";
    stage(name, name === "cleanup" ? 90 : name === "upload" ? 15 : 40 + Math.min(40, generation));
  }, path => {
    if (!inside(scratch, path)) throw new ContractError("PATH_OUTSIDE_ROOTS", "Upload is outside job scratch.");
    const fd = openJobFile(path, constants.O_RDONLY);
    const info = fstatSync(fd, {bigint: true});
    if (path === sealed && record.sealedIdentity !== [info.dev, info.ino, info.birthtimeNs].join("/")) {
      closeSync(fd);
      throw new ContractError("CONFLICT", "Sealed recording changed.");
    }
    return fd;
  }, async (op, response) => {
    const upload = receipt.uploads.at(-1);
    if (response.ok && upload) {
      if (op === "finalize") {
        const body = await response.clone().json().catch(() => null);
        if (!body?.file?.name) throw new ContractError("OUTCOME_UNKNOWN", "Unable to acknowledge the uploaded recording.");
        upload.expiresAt = typeof body.file.expirationTime === "string" ? body.file.expirationTime : null;
        upload.disposition = grant.retention === "provider" ? "kept" : "unconfirmed";
      } else if (op === "delete") upload.disposition = "deleted";
    }
    if (!response.ok && response.status >= 400 && response.status < 500 && op === "finalize" && upload) {
      upload.disposition = "not_obtained";
    }
    record.inFlight = null;
    save();
  }, authorize, () => { record.uncertain = true; save(); });

  const watcher = watch(directory, {persistent: false}, (_event, name) => { if (name === "cancel.request") refreshCancel(); });
  const output = join(scratch, "results");
  let stagedFolder: string | undefined;
  try {
    record.state = "running";
    stage("probe", 5);
    await authorize();
    store.createScratch(record);
    await seal(sealed);
    await authorize();
    const {GeminiVideoAnalyzer} = await import("../adapters/gemini.js");
    const analyzer = new GeminiVideoAnalyzer(key, model, {jobTransport: transport}, flags.thinkingLevel);
    store.createResults(record);
    if (record.family === "transcribe") {
      const {transcribe} = await import("./transcribe.js");
      const exports = await transcribe({input: sealed, output, apiKey: key, model, retention: grant.retention, json: flags.transcriptJson,
        signal: signal.signal}, {createAnalyzer: () => analyzer, probeDurationSeconds: async () => seconds, stdout() {}, stderr() {},
        ...(deps.sleep && {sleep: deps.sleep}), ...(deps.extractAudioTrack && {extractAudioTrack: deps.extractAudioTrack})}, {scratchRoot: scratch, authorize});
      stagedFolder = output;
      receipt.outputs = exports.paths.map(path => basename(path));
      record.state = "complete";
    } else {
      const recipe = await withAnalysisDepth(await loadRecipe(flags.recipe!), "standard");
      const {AnalysisOrchestrator} = await import("./analyze.js");
      const service = new AnalysisOrchestrator({createAnalyzer: () => analyzer, createContextSource() {throw new Error("Unexpected context source.");},
        probeDurationSeconds: async () => seconds});
      const result = await service.analyze({contextMode: "none", video: sealed, outputRoot: output, apiKey: key, model,
        recipe: recipe.recipe, recipeSha256: recipe.sha256, recipeRevision: recipe.revision, customRecipe: false, indexFps: recipe.indexFps,
        screenshots: false, calibrate: false, derivedTranscript: false, keepUpload: grant.retention === "provider", retention: grant.retention,
        expectedVideoSha256: record.digest, maxIncidents: 10, ...(flags.snap && {snapSettings: snapSettings()})},
      {jobScratchRoot: scratch, signal: signal.signal, onFailurePublished(path) {
        stagedFolder = path; receipt.outputs = ["failure-manifest.json"];
      }, progress: {async report(event) {
        await authorize();
        if (event.stage === "rendering") stage("publish", 85);
      }}});
      stagedFolder = result.directory;
      record.runId = result.manifest.runId;
      receipt.outputs = readdirSync(result.directory);
      record.state = result.outcome.status;
    }
    if (signal.signal.aborted) throw new ContractError("CANCELLED", "Job cancelled.");
  } catch (error) {
    const code = record.uncertain || record.inFlight ? "OUTCOME_UNKNOWN" : providerFailureCode(error);
    record.code = code;
    record.state = code === "OUTCOME_UNKNOWN" ? "outcome_unknown" : code === "CANCELLED" ? "cancelled" : "failed";
  } finally {
    // A returned failed outcome can contain only candidate validation failures.
    // A thrown provider refusal already carries its classified code.
    if (record.state === "failed") record.code ??= "COMMAND_FAILED";
    try {
      await authorize();
      if (stagedFolder) {
        const destination = join(directory, "output");
        if (existsSync(destination)) throw new ContractError("CONFLICT", "Output already exists.");
        inJobDirectory(directory, () => renameSync(join("scratch", "results"), "output"));
        record.runFolder = join(destination, relative(output, stagedFolder));
      }
    } catch (error) {
      receipt.outputs = [];
      delete record.runId;
      if (!record.uncertain) {
        record.code = faultCode(error);
        record.state = record.code === "CANCELLED" ? "cancelled" : "failed";
      }
    }
    watcher.close();
    refreshCancel();
    record.cancel.requested = signal.signal.aborted;
    if (!receipt.uploads.some(upload => upload.disposition !== "not_obtained")) receipt.mediaSeconds = 0;
    if (record.cancel.requested) record.cancel.steps.push("stopped new work", "worker joined");
    record.cancel.steps.push(...store.cleanScratch(record));
    if (grant.retention === "run" && receipt.uploads.some(upload => upload.disposition === "unconfirmed")) {
      record.code = "OUTCOME_UNKNOWN"; record.state = "outcome_unknown";
    }
    if (revoked) {
      record.state = "cancelled";
      record.code = "CANCELLED";
      record.reason = "grant_revoked";
    }
    record.percent = 100;
    if (record.state !== "outcome_unknown") record.stage = "finished";
    save();
  }
}
