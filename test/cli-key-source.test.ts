import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  writeFileSync(join(root, "account.cjs"), `
    require("node:os").userInfo = () => ({homedir: ${JSON.stringify(root)}});
    require("node:module").syncBuiltinESMExports();
  `);
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
    'if (process.env.FIXTURE_CLEAR_FLAGS) process.execArgv.length = 0;',
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
  writeFileSync(join(tools, "ffprobe"), '#!/bin/sh\necho \'{"streams":[{"codec_type":"video","time_base":"1/1000","duration_ts":1000,"index":0}],"format":{"duration":"1"}}\'\n', {mode: 0o700});
}, 60_000);
beforeEach(() => {
  rmSync(file, {force: true, recursive: true});
  rmSync(join(folder, "out", ".frameofmind-jobs"), {force: true, recursive: true});
});
afterAll(() => {
  rmSync(root, {recursive: true, force: true});
  if (build) rmSync(build, {recursive: true, force: true});
});
function run(runtime: "node" | "clean" | "bare", args: string[], env: NodeJS.ProcessEnv = {}, options: string[] = [], executableEntry = runtime === "node" ? entry : source) {
  const flags = runtime === "clean" ? ["--no-env-file"] : runtime === "node" ? ["--require", join(root, "account.cjs")] : [];
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

it.each(["node", "clean"] as const)("a clean %s job needs an environment key even with a folder key", runtime => {
  writeFileSync(file, "GEMINI_API_KEY=synthetic-folder\n");
  const result = run(runtime, start);
  expect(result.code).toBe(10);
  expect(JSON.parse(result.out).error.code).toBe("KEY_MISSING");
  expect(result.err).toBe("");
  expect(existsSync(join(folder, "out", ".frameofmind-jobs"))).toBe(false);
});

it.each([
  {runtime: "bare", source: "folder"}, {runtime: "bare", source: "environment"},
  {runtime: "node", source: "folder"}, {runtime: "node", source: "environment"},
] as const)("a merged $runtime job starts with a key from the $source", ({runtime, source}) => {
  writeFileSync(file, source === "folder" ? "GEMINI_API_KEY=synthetic-folder\n" : "");
  const env = {FIXTURE_COUNT_DISPATCH: "1", NODE_NO_WARNINGS: "1",
    GEMINI_API_KEY: source === "environment" ? "synthetic-job" : undefined};
  const offline = join(root, "offline.mjs");
  const options = runtime === "node" ? ["--env-file=.env", "--import", offline] : ["--preload", offline];
  const result = run(runtime, start, env, options, entry);
  expect(result.code).toBe(0);
  expect(result.err).toBe("dispatch\njobs import\n");
  const job = JSON.parse(result.out);
  expect(job.state).toBe("queued");
  expect(existsSync(join(folder, "out", ".frameofmind-jobs", job.jobId, "job.json"))).toBe(true);
});

it.each(["selector", "settings", "neither"])("a merged job without a key reports the configured source (%s)", kind => {
  writeFileSync(file, kind === "selector" ? "FRAME_OF_MIND_KEY_COMMAND=[]\n" : "");
  const directory = process.platform === "darwin" ? "Library/Application Support" : ".config";
  const settings = join(root, directory, "frameofmind", "settings.json");
  try {
    if (kind === "settings") {
      mkdirSync(dirname(settings), {recursive: true, mode: 0o700});
      writeFileSync(settings, JSON.stringify({keyCommand: [join(root, "fixture-reader")]}), {mode: 0o600});
    }
    const result = run("node", start, {}, ["--env-file=.env"]);
    expect(result.code).toBe(10);
    expect(JSON.parse(result.out).error.code).toBe(kind === "settings" && process.platform !== "win32"
      ? "KEY_REFUSED" : "KEY_MISSING");
    expect(existsSync(join(folder, "out", ".frameofmind-jobs"))).toBe(false);
  } finally { rmSync(settings, {force: true}); }
});

describe.each([
  {label: "--require", flags: ["--require", "node:path"]},
  {label: "NODE_OPTIONS require", flags: [], nodeOptions: "--require node:path"},
  {label: "--import", flags: ["--import", "node:path"]},
  {label: "-r", flags: ["-r", "node:path"]},
  {label: "loader", flags: ["--experimental-loader", "data:text/javascript,export{}"]},
])("Node $label", ({label, flags, nodeOptions}) => {
  it.each([
    {command: "--version", args: ["--version"]},
    {command: "doctor", args: ["doctor", "--json"]},
    {command: "job start", args: start},
  ])("$command matches plain Node", ({command, args}) => {
    writeFileSync(file, "GEMINI_API_KEY=synthetic-folder\n");
    const env = {NODE_OPTIONS: nodeOptions, NODE_NO_WARNINGS: "1"};
    const plain = run("node", args);
    const observed = run("node", args, env, flags);
    expect(observed.code, label + " " + command + " exit").toBe(plain.code);
    expect(observed).toEqual(plain);
  });
});

it.each(["--env-file", "--env-file-if-exists"])("Node %s reports unknown and dispatches job starts", flag => {
  writeFileSync(file, "GEMINI_API_KEY=synthetic-folder\n");
  const options = [flag, ".env", "--import", join(root, "offline.mjs")];
  const doctor = run("node", ["doctor", "--json"], {}, options);
  expect(doctor.code, "env-file doctor exit").toBe(0);
  const key = JSON.parse(doctor.out).key;
  expect(key.source, "env-file key source").toBe("unknown");
  expect(key.present).toBe(true);
  expect(run("node", ["doctor"], {}, options).out.split("\n")).toContain("ok GEMINI_API_KEY (unknown: started with --env-file)");
  expect(run("node", ["--version"], {}, options)).toEqual(run("node", ["--version"]));
  const counters = {FIXTURE_COUNT_DISPATCH: "1", FIXTURE_CLEAR_FLAGS: "1", NODE_NO_WARNINGS: "1"};
  const job = run("node", start, counters, options);
  expect(job.code, "bare Node job exit").toBe(0);
  const admitted = JSON.parse(job.out);
  expect(admitted.state).toBe("queued");
  expect(job.err, "bare Node job import").toBe("dispatch\njobs import\n");
  const textArgs = start.filter(arg => arg !== "--json");
  const text = run("node", textArgs, {}, options);
  expect(text).toEqual(run("node", textArgs));
  expect(text.err).toContain("--json");
  expect(text.err).not.toContain("Credential source unknown");
  expect(existsSync(join(folder, "out", ".frameofmind-jobs", admitted.jobId, "job.json"))).toBe(true);
}, 30_000);

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

const ordinaryCommands = [
  ["--help"], ["doctor", "--json"], ["analyze", "--source", "none", "--video", "absent.mp4"], ["transcribe", "absent.mp4"],
];
describe.each(["node", "clean"] as const)("folder data cannot select executables on clean launches (%s)", runtime => {
  it.each(ordinaryCommands.map(args => ({args, command: args[0]})))("$command", ({args}) => {
    const marker = join(folder, "tool-started");
    for (const name of ["ffmpeg", "ffprobe", "reader"]) {
      writeFileSync(join(folder, name), '#!/bin/sh\n: > tool-started\n', {mode: 0o700});
    }
    writeFileSync(file, ['GEMINI_API_KEY=folder-fixture', 'PATH=' + folder,
      'FRAME_OF_MIND_KEY_COMMAND=["' + join(folder, "reader") + '"]'].join("\n"));
    const result = run(runtime, args, {PATH: undefined});
    expect(existsSync(marker), runtime + " " + args[0] + " ran a folder executable").toBe(false);
    if (args[0] === "doctor") expect(JSON.parse(result.out).key.source).toBe("dotenv");
  });
});

it.each(["bare", "node"] as const)("doctor reports a merged folder key and gives a next step only when missing (%s)", runtime => {
  const options = runtime === "node" ? ["--env-file=.env"] : [];
  const label = runtime === "node" ? "unknown: started with --env-file" : "unknown: started under Bun without --no-env-file";
  for (const present of [true, false]) {
    writeFileSync(file, present ? "GEMINI_API_KEY=folder-fixture\n" : "");
    const json = run(runtime, ["doctor", "--json"], {}, options);
    expect(JSON.parse(json.out).key).toEqual({present, source: "unknown"});
    expect(json.code).toBe(present ? 0 : 1);
    const text = run(runtime, ["doctor"], {}, options);
    expect(text.code).toBe(present ? 0 : 1);
    const lines = text.out.trimEnd().split("\n");
    expect(lines).toContain((present ? "ok" : "--") + " GEMINI_API_KEY (" + label + ")");
    expect(lines.filter(line => line.startsWith("Next step:"))).toHaveLength(present ? 0 : 1);
  }
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
  "preserves doctor detail bytes and ends text with a next step only when needed for %s", scenario => {
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
    const needsStep = !present;
    expect(lines.filter(line => line.startsWith("Next step")).length, "next-step count").toBe(Number(needsStep));
    expect(lines.at(-1)!.startsWith("Next step")).toBe(needsStep);
    expect(lines.includes("Lower-priority sources were skipped.")).toBe(scenario === "environment");
  });
