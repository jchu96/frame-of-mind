import { fixtureSource } from "./helpers/source-clock.js";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { runJobCommand } from "../src/commands/jobs.js";
import { validateCliDocument } from "./helpers/cli-schema.js";

let root: string;
let read: string;
let out: string;
let retentionWork: Promise<void> | undefined;
const model = "gemini-fixture";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cli-job-")));
  read = join(root, "read");
  out = join(root, "out");
  await Promise.all([mkdir(read), mkdir(out)]);
  await writeFile(join(read, "clip.mp4"), "fixture");
});
async function removeJobFixture(directory: string, work?: Promise<void>) {
  try {
    await work;
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}
afterEach(() => {
  const work = retentionWork;
  retentionWork = undefined;
  return removeJobFixture(root, work);
});
function provider(generation: Response | ((body: string) => object) = body =>
  body.includes("matchNotes") ? {matchNotes: "fixture", moments: []} : {segments: []}) {
  const inventory = new Set<string>();
  const calls: string[] = [];
  let afterFinalize = async () => {};
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
    const request = new URL(input);
    expect(request.hostname).toBe("generativelanguage.googleapis.com");
    const upload = new Headers(init.headers).get("x-goog-upload-command");
    const op = upload === "start" ? "start" : upload ? "finalize" : init.method === "DELETE" ? "delete" : "generate";
    calls.push(op);
    if (op === "start") return new Response(null, {headers: {"x-goog-upload-url": request.origin + "/upload/resumable"}});
    if (op === "finalize") {
      for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) { /* consume the synthetic upload */ }
      inventory.add("files/fixture");
      await afterFinalize();
      return Response.json({file: {name: "files/fixture", uri: request.origin + "/v1beta/files/fixture", state: "ACTIVE"}});
    }
    if (op === "delete") {
      expect(inventory.delete("files/fixture")).toBe(true);
      return Response.json({});
    }
    expect(inventory.size).toBe(1);
    if (generation instanceof Response) return generation;
    const payload = generation(String(init.body));
    return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(payload)}]}}]});
  });
  return { inventory, calls, onFinalize(fn: () => Promise<void>) { afterFinalize = fn; } };
}
function folders() { return ["--media-root", read, "--output-root", out, "--out", out]; }
function startArgs(family: string, retention = "run", limit = 8) {
  return [join(read, "clip.mp4"), ...folders(), "--max-provider-requests", String(limit), "--max-file-bytes", "16",
    "--max-media-seconds", "2", "--allowed-models", model, "--retention", retention, "--request-id", randomUUID(),
    ...(family === "analyze" ? ["--recipe", "requirements"] : []), "--json"];
}
async function call(family: "analyze" | "transcribe", op: Parameters<typeof runJobCommand>[1], args: string[],
  admitted?: (job: any) => void, readKey?: () => string | undefined) {
  let result: any;
  const diagnostics = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
    result = JSON.parse(String(chunk));
    return true;
  });
  const capture = (document: object) => { result = {schemaVersion: 1, ...document}; };
  process.exitCode = 0;
  try {
    await runJobCommand(family, op, args, {readKey, withSourceRecording: fixtureSource(() => 2), probe: async () => 2, sleep: async () => {}, extractAudioTrack: async (_input, output) => {
      expect(output.startsWith(out + "/")).toBe(true);
      await writeFile(output, "aac"); return true;
    }}, {write: capture, admit: async doc => { capture(doc); admitted?.(doc); }});
    expect(result, "one machine answer").toBeDefined();
    validateCliDocument(op === "dry-run" ? "analyze-dry-run" : op === "result" ? "job-result" : "job", JSON.stringify(result));
    return {doc: result, exit: process.exitCode};
  } finally { diagnostics.mockRestore(); process.exitCode = 0; }
}
async function record(id: string) {
  return JSON.parse(await readFile(join(out, ".frameofmind-jobs", id, "job.json"), "utf8"));
}
beforeEach(() => { vi.stubEnv("GEMINI_API_KEY", "stand-in"); });

it("job options cannot supply credentials and inspection needs none", async () => {
  vi.stubEnv("GEMINI_API_KEY", undefined);
  const args = startArgs("analyze");
  for (const option of ["--api-key", "--key-command", "--settings-file"]) {
    const result = await call("analyze", "start", [...args, option, "synthetic-private"]);
    expect(result.doc).toEqual({schemaVersion: 1, error: {code: "USAGE", message: "Invalid command arguments.", details: {reason: "unknown-option"}}});
  }
  expect((await call("analyze", "start", args)).doc.error.code).toBe("KEY_MISSING");
  expect(await readdir(out)).toEqual([]);
  args.splice(args.indexOf("--request-id"), 2);
  const refuseRead = vi.fn(() => { throw new Error("unexpected credential acquisition"); });
  expect((await call("analyze", "dry-run", args, undefined, refuseRead)).doc.seconds).toBe(2);
  for (const op of ["status", "result", "cancel"] as const) {
    expect((await call("analyze", op, [randomUUID(), ...folders(), "--json"], undefined, refuseRead)).doc.error.code).toBe("JOB_NOT_FOUND");
  }
  expect(refuseRead).not.toHaveBeenCalled();
});

it("released-second-pass-request matches v0.6.8 with and without a surface and preserves thinking configuration", async () => {
  const bodies: string[] = [];
  let surface: string | undefined;
  const fake = provider(body => {
    bodies.push(body);
    const schema = JSON.parse(body).generationConfig.responseJsonSchema;
    if (schema.properties.matchNotes) return {matchNotes: "fixture", moments: [
      {start: "00:00:00", end: "00:00:01", kind: "change", summary: "Fixture change", importance: "low", ...(surface && {surface})},
    ]};
    return {accepted: true, kind: "change", title: "Fixture", summary: "Fixture change", evidence: {timestamp: "00:00:00"}};
  });
  async function run(args: string[]) {
    const {doc} = await call("analyze", "start", args);
    expect(doc.error).toBeUndefined();
    const result = await call("analyze", "result", [doc.jobId, ...folders(), "--json"]);
    expect(result.doc.error).toBeUndefined();
    return JSON.parse(await readFile(join(result.doc.runFolder, "manifest.json"), "utf8"));
  }

  expect(await run(startArgs("analyze"))).not.toHaveProperty("thinkingLevel");
  const base = bodies.splice(0);
  // Complete HTTP body digests from this fixture at tag v0.6.8.
  expect(base.map(body => createHash("sha256").update(body).digest("hex"))).toEqual([
    "8548557fde88664b225d4576756704ff87181361408721120776f5d2fcaa2890",
    "b8dfdafdb2dbb2bf880ddffd65125375d9753c769db44039d6c009363a28945c",
  ]);
  for (const body of base) expect(JSON.parse(body).generationConfig).not.toHaveProperty("thinkingConfig");

  const args = startArgs("analyze");
  surface = "Review & details";
  await run(startArgs("analyze"));
  const releasedSurfaceSlot = " on an unknown surface.";
  expect(base[1]).toContain(releasedSurfaceSlot);
  expect(bodies.splice(0)).toEqual([base[0], base[1]!.replace(releasedSurfaceSlot, " on Review &amp; details.")]);
  surface = undefined;

  const priorCalls = fake.calls.length;
  const invalid = await call("analyze", "start", [...args, "--thinking-level", "xhigh"]);
  expect([invalid.doc.error.code, invalid.exit, fake.calls.length]).toEqual(["USAGE", 2, priorCalls]);
  expect(await run([...args, "--thinking-level", "medium"])).toHaveProperty("thinkingLevel", "medium");
  expect(bodies).toHaveLength(base.length);
  for (const [i, body] of bodies.entries()) {
    const expected = JSON.parse(base[i]!);
    expected.generationConfig.thinkingConfig = {thinkingLevel: "MEDIUM"};
    expect(JSON.parse(body)).toEqual(expected);
  }
  const callsBeforeReplay = fake.calls.length;
  const replay = await call("analyze", "start", [...args, "--thinking-level", "low"]);
  expect([replay.doc.error.code, replay.exit, fake.calls.length]).toEqual(["REQUEST_CONFLICT", 30, callsBeforeReplay]);
});

it("J01 reopens a narrowed grant and refuses links outside the selected root", async () => {
  const fake = provider();
  const grant = join(root, "grant.json");
  const other = join(root, "other");
  await mkdir(other);
  const change = (dir: string) => writeFile(grant, JSON.stringify({schemaVersion: 1, read: [dir], write: [out]}));
  const args = startArgs("analyze");
  args.splice(1, 4, "--roots-file", grant);
  args.splice(args.indexOf("--request-id"), 2);
  await change(read);
  const absentOut = [...args];
  absentOut[absentOut.indexOf("--out") + 1] = join(out, "missing");
  const missingOut = await call("analyze", "dry-run", absentOut);
  const missingFile = await call("analyze", "dry-run", [join(read, "missing.mp4"), ...args.slice(1)]);
  expect([missingOut, missingFile, await readdir(out)]).toMatchObject([
    {exit: 20, doc: {error: {code: "NOT_FOUND", message: "The --out folder does not exist.", details: {argument: "out"}}}},
    {exit: 20, doc: {error: {code: "NOT_FOUND", message: "The input file does not exist.", details: {argument: "file"}}}},
    [],
  ]);
  expect((await call("analyze", "dry-run", args)).doc).toMatchObject({bytes: 7, seconds: 2, model, retention: "run"});
  await change(other);
  expect((await call("analyze", "dry-run", args)).doc.error?.code, "path outside the current grant").toBe("PATH_OUTSIDE_ROOTS");
  await symlink(read, join(other, "link"), "dir");
  args[0] = join(other, "link", "clip.mp4");
  expect((await call("analyze", "dry-run", args)).doc.error?.code, "path outside the current grant").toBe("PATH_OUTSIDE_ROOTS");
  expect(fake.calls).toEqual([]);
  const escapedOut = join(out, "linked-output");
  await symlink(other, escapedOut, "dir");
  const deniedWrite = startArgs("analyze");
  deniedWrite[deniedWrite.indexOf("--out") + 1] = escapedOut;
  expect((await call("analyze", "start", deniedWrite)).doc.error?.code).toBe("PATH_OUTSIDE_ROOTS");
  expect(await readdir(other)).toEqual(["link"]);
  await rm(escapedOut);
  expect(await readdir(read)).toEqual(["clip.mp4"]);
  expect(await readdir(out)).toEqual([]);
  await change(read);
  const start = startArgs("transcribe");
  start.splice(1, 4, "--roots-file", grant);
  fake.onFinalize(async () => {
    await writeFile(grant, JSON.stringify({schemaVersion: 1, read: [read], write: [other]}));
  });
  const accepted = await call("transcribe", "start", start);
  const terminal = await record(accepted.doc.jobId);
  expect(terminal).toMatchObject({state: "cancelled", reason: "grant_revoked", receipt: {outputs: [], providerRequests: 3}});
  expect(fake.calls).toEqual(["start", "finalize", "delete"]);
  expect(fake.inventory.size).toBe(0);
  const entries = await readdir(join(out, ".frameofmind-jobs", accepted.doc.jobId));
  expect(entries).not.toContain("scratch");
  expect(entries).not.toContain("output");

  // Losing the job folder before the worker can record revocation must not
  // send anything or create a fallback record anywhere else.
  await change(read);
  start[start.indexOf("--request-id") + 1] = randomUUID();
  const parked = join(root, "unavailable");
  const interrupted = await call("transcribe", "start", start, job => {
    writeFileSync(grant, JSON.stringify({schemaVersion: 1, read: [read], write: [other]}));
    renameSync(join(out, ".frameofmind-jobs", job.jobId), parked);
  });
  expect(await readdir(other)).toEqual(["link"]);
  expect(fake.calls).toEqual(["start", "finalize", "delete"]);
  renameSync(parked, join(out, ".frameofmind-jobs", interrupted.doc.jobId));
  await change(read);
  const settled = await call("transcribe", "status", [interrupted.doc.jobId, "--out", out, "--roots-file", grant, "--json"]);
  expect(settled.doc).toMatchObject({state: "outcome_unknown", receipt: {providerRequests: 0, outputs: []}});
});

it("J02 refuses excess bytes, seconds and window generation before dispatch", async () => {
  const fake = provider();
  const args = startArgs("transcribe", "run", 3);
  for (const [flag, code] of [["--max-media-seconds", "MEDIA_LIMIT"], ["--max-file-bytes", "FILE_LIMIT"]]) {
    const values = [...args]; values[values.indexOf(flag!) + 1] = "1";
    expect((await call("transcribe", "start", values)).doc.error.code).toBe(code);
  }
  expect(fake.calls).toEqual([]);
  const {doc} = await call("transcribe", "start", args);
  const result = await call("transcribe", "result", [doc.jobId, ...folders(), "--json"]);
  expect(fake.calls, "stand-in request sequence at limit 3").toEqual(["start", "finalize", "delete"]);
  expect(result.doc.error.code).toBe("PROVIDER_LIMIT");
  expect(result.doc.error.details.receipt.providerRequests).toBe(fake.calls.length);
  const kept = await call("transcribe", "start", startArgs("transcribe", "provider", 3));
  expect((await record(kept.doc.jobId)).state).toBe("complete");
  expect(fake.calls.slice(3)).toEqual(["start", "finalize", "generate"]);
});

it("J03 refuses each missing grant before creating a job", async () => {
  const fake = provider();
  vi.stubEnv("FRAME_OF_MIND_UPLOAD_RETENTION", "provider");
  vi.stubEnv("GEMINI_MODEL", model);
  for (const flag of ["--media-root", "--output-root", "--max-provider-requests", "--max-media-seconds", "--max-file-bytes", "--allowed-models", "--retention"]) {
    const args = startArgs("analyze");
    args.splice(args.indexOf(flag), 2);
    const {doc, exit} = await call("analyze", "start", args);
    expect([doc.error?.code, exit], flag).toEqual(["USAGE", 2]);
  }
  expect(fake.calls).toEqual([]);
  expect(await readdir(out)).toEqual([]);
});

it("J04 keeps or deletes acquired recordings and windows after success and cancel", ({signal}) => {
  retentionWork = checkRetentionCases(signal);
  return retentionWork;
});

async function checkRetentionCases(signal: AbortSignal) {
  const finished: {name: string; ms: number}[] = [];
  let current = "";
  const report = () => console.error("J04 interrupted", {current, finished: [...finished]});
  signal.addEventListener("abort", report, {once: true});
  try {
    for (const family of ["analyze", "transcribe"] as const) {
      for (const retention of ["provider", "run"]) {
        for (const cancel of [false, true]) {
          current = `${family}-${retention}-${cancel ? "cancel" : "success"}`;
          const started = performance.now();
          out = join(root, current);
          await mkdir(out);
          await checkRetention(family, retention, cancel);
          finished.push({name: current, ms: Math.round(performance.now() - started)});
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", report);
  }
}

async function checkRetention(family: "analyze" | "transcribe", retention: string, cancel: boolean) {
  const fake = provider();
  let id: string;
  if (cancel) fake.onFinalize(async () => {
    expect((await call(family, "cancel", [id, ...folders(), "--json"])).doc.state).toBe("cancelling");
  });
  const args = startArgs(family, retention);
  if (family === "transcribe") args.push("--transcript-json");
  const {doc} = await call(family, "start", args, job => { id = job.jobId; });
  const status = await call(family, "status", [doc.jobId, ...folders(), "--json"]);
  expect(status.doc.state, JSON.stringify(status.doc)).toBe(cancel ? "cancelled" : "complete");
  expect(fake.inventory.size, family + " retention " + retention + " after " + (cancel ? "cancel" : "success")).toBe(retention === "provider" ? 1 : 0);
  expect(fake.calls).toEqual(["start", "finalize", ...(cancel ? [] : ["generate"]), ...(retention === "run" ? ["delete"] : [])]);
  const durable = await record(doc.jobId);
  expect(durable.receipt.uploads[0].disposition).toBe(retention === "provider" ? "kept" : "deleted");
  expect(JSON.stringify(durable)).not.toMatch(/"[^"]*tokens?[^"]*"\s*:/i);
  const result = await call(family, "result", [doc.jobId, ...folders(), "--json"]);
  if (cancel) expect(result.exit).toBe(130);
  else expect(result.doc.runFolder.startsWith(out + "/")).toBe(true);
}

it("J04 teardown keeps the fixture available until its writer settles", async () => {
  const directory = await mkdtemp(join(root, "writer-"));
  const fetchStandIn = vi.fn();
  vi.stubGlobal("fetch", fetchStandIn);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const writer = held.then(async () => {
    expect(globalThis.fetch, "worker still owns its provider fixture").toBe(fetchStandIn);
    await writeFile(join(directory, "result"), "complete");
  });
  const cleanup = removeJobFixture(directory, writer);
  release();
  await Promise.all([writer, cleanup]);
  await expect(readdir(directory)).rejects.toMatchObject({code: "ENOENT"});
});

it("J05 a lost reply costs one upload and a replacement requires the unknown job ID", async () => {
  const fake = provider();
  fake.onFinalize(async () => { throw new TypeError("lost reply"); });
  const args = startArgs("transcribe");
  const {doc} = await call("transcribe", "start", args);
  expect(fake.calls.filter(op => op === "finalize"), "uploads after lost reply").toHaveLength(1);
  expect(await record(doc.jobId)).toMatchObject({state: "outcome_unknown", code: "OUTCOME_UNKNOWN",
    receipt: {providerRequests: 2, mediaSeconds: 2}});
  const replay = await call("transcribe", "start", args);
  expect(replay.doc.jobId).toBe(doc.jobId);
  args[args.indexOf("--request-id") + 1] = randomUUID();
  expect((await call("transcribe", "start", args)).doc.error.code).toBe("UNKNOWN_JOB_REQUIRED");
  expect(fake.calls).toEqual(["start", "finalize"]);
  fake.onFinalize(async () => {});
  const replacement = await call("transcribe", "start", [...args, "--after-unknown", doc.jobId]);
  expect((await record(replacement.doc.jobId)).state).toBe("complete");
});

it("records KEY_REFUSED and returns exit 10 when the provider rejects an analyze job's key", async () => {
  const fake = provider(Response.json({error: {code: 400, details: [
    {"@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID"},
  ]}}, {status: 400}));
  const {doc} = await call("analyze", "start", startArgs("analyze"));
  expect(fake.calls).toEqual(["start", "finalize", "generate", "delete"]);
  const job = await record(doc.jobId);
  const result = await call("analyze", "result", [doc.jobId, ...folders(), "--json"]);
  expect([job.state, job.code, result.doc.error.code, result.exit]).toEqual(["failed", "KEY_REFUSED", "KEY_REFUSED", 10]);
});
