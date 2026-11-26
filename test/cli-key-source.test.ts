import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { buildCliFixture } from "./helpers/cli-build.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-source-")));
const folder = join(root, "project");
const tools = join(root, "tools");
const file = join(folder, ".env");
const source = resolve("src/cli.ts");
const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {encoding: "utf8"}).trim();
let build: string;
let entry: string;

beforeAll(async () => {
  build = await buildCliFixture();
  entry = join(build, "dist/cli.js");
  writeFileSync(join(root, "offline.mjs"), 'globalThis.fetch = async () => { throw new Error("offline fixture"); };');
  writeFileSync(join(root, "observe-entry.mjs"), `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { resolve } from "node:path";
    import { pathToFileURL } from "node:url";
    const open = fs.openSync;
    const read = fs.readFileSync;
    let fileAccess = false;
    for (const [name, original] of [["openSync", open], ["readFileSync", read]]) {
      fs[name] = function(path, ...args) {
        if (typeof path === "string" && resolve(path) === resolve(".env")) fileAccess = true;
        return original.call(this, path, ...args);
      };
    }
    syncBuiltinESMExports();
    globalThis.fetch = async () => { throw new Error("offline fixture"); };
    process.argv.splice(1, 1);
    await import(pathToFileURL(process.argv[1]));
    process.stderr.write(JSON.stringify({fileAccess, merged: Object.hasOwn(process.env, "FIXTURE_FOLDER_ONLY")}));
  `);
  // Observe the split in the disposable compiled entry. The counters contain no inputs.
  const split = join(build, "dist/job-invocation.js");
  const counter = [
    'if (process.env.FIXTURE_COUNT_DISPATCH) process.stderr.write("dispatch\\n");',
    'if (process.env.FIXTURE_CLEAR_LIVE_KEY) delete process.env.GEMINI_API_KEY;',
  ].join("\n");
  const original = readFileSync(split, "utf8");
  const instrumented = original.replace("function jobInvocation(args) {", "function jobInvocation(args) {" + counter);
  expect(instrumented).not.toBe(original);
  writeFileSync(split, instrumented);
  const jobs = join(build, "dist/commands/jobs.js");
  writeFileSync(jobs, 'if (process.env.FIXTURE_COUNT_DISPATCH) process.stderr.write("jobs import\\n");\n' + readFileSync(jobs, "utf8"));
  const settings = join(build, "dist/cli-settings.js");
  const originalSettings = readFileSync(settings, "utf8");
  const observedSettings = originalSettings.replace("providerKey() {", 'providerKey() { if (process.env.FIXTURE_COUNT_READS) process.stderr.write("key read\\n");');
  expect(observedSettings).not.toBe(originalSettings);
  writeFileSync(settings, observedSettings);
  mkdirSync(folder);
  mkdirSync(tools);
  writeFileSync(join(folder, "clip.mp4"), "synthetic");
  mkdirSync(join(folder, "out"));
  writeFileSync(join(tools, "ffprobe"), '#!/bin/sh\necho \'{"streams":[{"codec_type":"video"}],"format":{"duration":"1"}}\'\n', {mode: 0o700});
}, 60_000);
beforeEach(() => rmSync(file, {force: true, recursive: true}));
afterAll(() => {
  rmSync(root, {recursive: true, force: true});
  if (build) rmSync(build, {recursive: true, force: true});
});
function run(runtime: "node" | "clean" | "bare", args: string[], env: NodeJS.ProcessEnv = {}, options: string[] = [], executableEntry = runtime === "node" ? entry : source) {
  const flags = runtime === "clean" ? ["--no-env-file"] : [];
  const result = spawnSync(runtime === "node" ? process.execPath : bun,
    [...flags, ...options, executableEntry, ...args], {
      cwd: folder, env: {HOME: root, TMPDIR: root, PATH: tools, SystemRoot: process.env.SystemRoot, ...env},
      encoding: "utf8", timeout: 10_000,
    });
  if (result.error) throw result.error;
  return {code: result.status, out: result.stdout, err: result.stderr};
}
const start = ["analyze", "start", "clip.mp4", "--json", "--out", join(folder, "out"), "--media-root", folder,
  "--output-root", join(folder, "out"), "--recipe", "requirements", "--allowed-models", "gemini-fixture",
  "--request-id", "f454f1d6-3262-4544-ab14-e3d03bcf7d91", "--retention", "run", "--max-provider-requests", "1",
  "--max-media-seconds", "2", "--max-file-bytes", "32"];

it("classifies launches before job dispatch with a real folder assignment", () => {
  writeFileSync(file, "GEMINI_API_KEY=synthetic-folder\n");
  for (const runtime of ["node", "clean", "bare"] as const) {
    const result = run(runtime, start, {}, runtime === "bare" ? ["--preload", join(root, "offline.mjs")] : []);
    const bare = runtime === "bare";
    expect(result.code, runtime + " job exit").toBe(bare ? 2 : 10);
    expect(JSON.parse(result.out).error.code).toBe(bare ? "USAGE" : "KEY_MISSING");
    expect(result.err).toBe("");
  }
  for (const options of [["--env-file=.env"], ["--require", "node:path"], ["--import", "node:path"]]) {
    const result = run("node", ["--version"], {}, options);
    expect(result).toEqual({code: 2, err: "Credential source unknown. Start with a clean launcher.\n", out: ""});
  }
  const counters = {FIXTURE_COUNT_DISPATCH: "1"};
  expect(run("node", start, counters, ["--require", "node:path"]).err, "dispatch before refusal").toBe("");
  expect(run("bare", start, counters, ["--preload", join(root, "offline.mjs")], entry).err, "bare job import").toBe("dispatch\n");
  expect(existsSync(join(folder, "out", ".frameofmind-jobs"))).toBe(false);
});

it("keeps ordinary folder settings out of process.env and job starts out of the folder file", () => {
  writeFileSync(file, "GEMINI_API_KEY=synthetic-folder\nFIXTURE_FOLDER_ONLY=marker\nFRAME_OF_MIND_OUTPUT=fixture-output\n");
  const observer = join(root, "observe-entry.mjs");
  const ordinary = run("node", [entry, "doctor", "--json"], {}, [], observer);
  expect(JSON.parse(ordinary.out).artifactRoot).toBe(join(folder, "fixture-output"));
  expect(JSON.parse(ordinary.err)).toEqual({fileAccess: true, merged: false});
  const job = run("node", [entry, ...start], {}, [], observer);
  expect(JSON.parse(job.out).error.code).toBe("KEY_MISSING");
  expect(JSON.parse(job.err)).toEqual({fileAccess: false, merged: false});
});

it("a clean job consumes the inherited snapshot even after live environment changes", () => {
  const observer = join(root, "observe-entry.mjs");
  const result = run("node", [entry, ...start], {GEMINI_API_KEY: "synthetic-job", FIXTURE_CLEAR_LIVE_KEY: "1"}, [], observer);
  expect(result.code).toBe(0);
  const admitted = JSON.parse(result.out);
  expect(admitted.state).toBe("queued");
  const record = JSON.parse(readFileSync(join(folder, "out", ".frameofmind-jobs", admitted.jobId, "job.json"), "utf8"));
  expect(record.code).toBe("PROVIDER_LIMIT");
  expect(record.receipt.providerRequests).toBe(0);
  expect(JSON.stringify([record, admitted]).includes("synthetic-job")).toBe(false);
});

it("reports environment identically for equal and different folder keys", () => {
  const env = {GEMINI_API_KEY: "higher-fixture"};
  function report(lower: string) {
    writeFileSync(file, "GEMINI_API_KEY=" + lower);
    return run("clean", ["doctor", "--json"], env);
  }
  const first = report("higher-fixture");
  expect(JSON.parse(first.out).key).toEqual({present: true, source: "environment", lowerSourcesSkipped: true});
  expect(first).toEqual(report("different-fixture"));
});

it.each([["--help"], ["--version"], ["doctor", "--json"], ["key", "set"], ["analyze", "status", "missing", "--out", folder, "--json"]])(
  "inspection does not acquire a provider key (%#)", (...args) => {
    writeFileSync(file, "GEMINI_API_KEY=fixture\n");
    const result = run("node", args, {FIXTURE_COUNT_READS: "1"});
    expect(result.err, "consumer credential read during inspection").not.toContain("key read\n");
  });

it.each(["node", "clean"] as const)("folder data cannot select executables on clean launches (%s)", runtime => {
  const marker = join(folder, "tool-started");
  for (const name of ["ffmpeg", "ffprobe", "reader"]) {
    writeFileSync(join(folder, name), '#!/bin/sh\n: > tool-started\n', {mode: 0o700});
  }
  writeFileSync(file, ['GEMINI_API_KEY=folder-fixture', 'PATH=' + folder,
    'FRAME_OF_MIND_KEY_COMMAND=["' + join(folder, "reader") + '"]'].join("\n"));
  for (const args of [["--help"], ["doctor", "--json"], ["analyze", "--source", "none", "--video", "absent.mp4"], ["transcribe", "absent.mp4"]]) {
    const result = run(runtime, args, {PATH: undefined});
    expect(existsSync(marker), runtime + " " + args[0] + " ran a folder executable").toBe(false);
    if (args[0] === "doctor") expect(JSON.parse(result.out).key.source).toBe("dotenv");
  }
  expect(JSON.parse(run("bare", ["doctor", "--json"]).out).key).toEqual({present: true, source: "unknown"});
});

it.each([["synthetic", "longer-fixture-value"], ["two words", "longer invalid input"]])(
  "keeps both public streams independent of credential bytes (%#)", (a, b) => {
    const streams = (key: string) => ["doctor", "json"].map(mode => run("clean",
      mode === "json" ? ["doctor", "--json"] : ["doctor"], {GEMINI_API_KEY: key}));
    const pair = [a, b];
    const [first, second] = pair.map(key => streams(key));
    expect(JSON.stringify(first) === JSON.stringify(second), "credential-dependent public streams").toBe(true);
    for (const key of pair) expect(JSON.stringify(first).includes(key), "credential in public streams").toBe(false);
});

it.each(["none", "environment", "dotenv", "unavailable", "unknown"] as const)(
  "preserves doctor detail bytes and ends text with one applicable next step for %s", scenario => {
    if (scenario === "dotenv") writeFileSync(file, "GEMINI_API_KEY=fixture");
    if (scenario === "unavailable") mkdirSync(file);
    const runtime = scenario === "unknown" ? "bare" : "node";
    const present = ["environment", "dotenv", "unknown"].includes(scenario);
    const env = scenario === "environment" || scenario === "unknown" ? {GEMINI_API_KEY: "synthetic"} : {};
    const json = JSON.parse(run(runtime, ["doctor", "--json"], env).out);
    expect(json.checks.find((row: {name: string}) => row.name === "provider_key"))
      .toEqual({name: "provider_key", ok: present, required: true, detail: present ? "configured" : "missing"});
    const label = {environment: "process environment", none: "none", dotenv: JSON.stringify(file),
      unavailable: JSON.stringify(file) + ", unavailable", unknown: "unknown: started under Bun without --no-env-file"}[scenario];
    const lines = run(runtime, ["doctor"], env).out.trimEnd().split("\n");
    expect(lines).toContain((present ? "ok" : "--") + " GEMINI_API_KEY (" + label + ")");
    const needsStep = !present || scenario === "unknown";
    expect(lines.filter(line => line.startsWith("Next step")).length, "next-step count").toBe(Number(needsStep));
    expect(lines.at(-1)!.startsWith("Next step")).toBe(needsStep);
    expect(lines.includes("Lower-priority sources were skipped.")).toBe(scenario === "environment");
  });
