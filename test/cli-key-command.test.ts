import { fixtureMovieHeader } from "../scripts/fixture-movie-header.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeFixtureRuntime } from "./helpers/key-command-runtime.js";
import { buildCliFixture } from "./helpers/cli-build.js";
import { validateCliDocument } from "./helpers/cli-schema.js";
import { operations } from "../src/job-invocation.js";

describe.skipIf(process.platform === "win32")("CLI key command", () => {
  let fixtureRuntime: string, root: string, home: string, cwd: string, settings: string, reader: string, marker: string, build: string, preload: string;
  const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {encoding: "utf8"}).trim();
  const source = resolve("src/cli.ts");
  let folderSettings: string;
  beforeAll(async () => {
    build = await buildCliFixture();
    root = realpathSync(mkdtempSync(join(tmpdir(), "cli-key-command-")));
    home = join(root, "home");
    cwd = join(root, "project");
    mkdirSync(cwd);
    const suffix = process.platform === "darwin" ? "Library/Application Support/frameofmind/settings.json" : ".config/frameofmind/settings.json";
    const decoy = join(root, "redirect");
    const decoyFile = join(decoy, suffix);
    settings = join(home, suffix);
    marker = join(root, "started");
    reader = join(home, "reader.mjs");
    for (const path of [settings, decoyFile]) mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    fixtureRuntime = writeFixtureRuntime(home);
    const decoyCommand = [writeFixtureRuntime(decoy), join(decoy, "reader.mjs")];
    for (const path of [reader, join(decoy, "reader.mjs")]) writeFileSync(path,
      'import fs from "node:fs"; fs.appendFileSync(' + JSON.stringify(marker) + ', "start\\n"); process.stdout.write("synthetic")');
    writeFileSync(decoyFile, JSON.stringify({keyCommand: decoyCommand}), {mode: 0o600});
    const roots = ["HOME", "XDG_CONFIG_HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"];
    folderSettings = [...roots.map(name => name + "=" + decoy),
      "FRAME_OF_MIND_KEY_COMMAND=" + JSON.stringify(decoyCommand), "GEMINI_API_KEY=synthetic-folder"].join("\n");
    preload = join(root, "account.cjs");
    writeFileSync(preload, `
      const os = require('node:os'), fs = require('node:fs');
      os.userInfo = () => ({homedir: ${JSON.stringify(home)}});
      const original = fs.openSync;
      let settingsFd;
      const fstat = fs.fstatSync;
      fs.fstatSync = function(fd, ...args) {
        const result = fstat(fd, ...args);
        if (process.env.FOREIGN_FILE && fd === settingsFd) result.uid++;
        return result;
      };
      fs.openSync = function(path, ...args) {
        if (String(path).startsWith(${JSON.stringify(decoy)}) || (process.env.OBSERVE_FOLDER && path === ${JSON.stringify(join(cwd, ".env"))})
          || (process.env.OBSERVE_ACCOUNT && path === ${JSON.stringify(settings)})) {
          fs.appendFileSync(${JSON.stringify(join(root, "unexpected-open"))}, "open\\n");
        }
        const fd = original(path, ...args);
        if (path === ${JSON.stringify(settings)}) settingsFd = fd;
        return fd;
      };
      if (process.env.CONSUMER_FIXTURE) {
        Date.prototype.toISOString = () => "2026-01-01T00:00:00.000Z";
        Date.now = () => 1767225600000;
        require("node:crypto").randomUUID = () => "11111111-1111-4111-8111-111111111111";
      }
      require('node:module').syncBuiltinESMExports();
      global.fetch = async (_url, init) => {
        if (!process.env.CONSUMER_FIXTURE) throw Error('offline fixture');
        const matched = new Headers(init.headers).get("x-goog-api-key") === process.env.FIXTURE_ANSWER;
        fs.writeFileSync("consumer-result", matched ? "accepted" : "wrong source");
        return new Response(null, {status: 403});
      };
    `);
  }, 60_000);
  beforeEach(() => {
    writeFileSync(join(cwd, ".env"), folderSettings);
    for (const path of [marker, settings, join(root, "unexpected-open")]) rmSync(path, {force: true});
  });
  afterAll(() => {
    if (build) rmSync(build, {recursive: true, force: true});
    if (root) rmSync(root, {recursive: true, force: true});
  });
  function run(args: string[], env: NodeJS.ProcessEnv = {}, runtime = "node", timeout = 8000) {
    const node = runtime.startsWith("node");
    const entry = node ? join(build, "dist/cli.js") : source;
    const flags = node ? ["--require", preload, ...(runtime === "node-bare" ? ["--env-file=.env"] : [])]
      : runtime === "bun-clean" ? ["--no-env-file"] : [];
    const result = spawnSync(node ? process.execPath : bun, [...flags, entry, ...args], {
      cwd, env: {PATH: "", HOME: home, TMPDIR: root, ...env}, timeout, encoding: "utf8",
    });
    if (result.error) throw result.error;
    return {exit: result.status, out: result.stdout, err: result.stderr};
  }
  it.each(["node", "bun-clean", "node-bare", "bun-bare"])("keeps folder data out of command selection (%s)", runtime => {
    rmSync(settings, {force: true});
    const result = run(["doctor", "--json"], {}, runtime);
    const report = JSON.parse(result.out);
    expect(report.key.source).toBe(runtime.endsWith("bare") ? "unknown" : "dotenv");
    if (!runtime.endsWith("bare")) expect(report.settingsPath).toBe(settings);
    expect(existsSync(join(root, "unexpected-open"))).toBe(false);
    if (runtime.endsWith("bare")) {
      expect(report.settingsPath).toBeUndefined();
    } else {
      rmSync(join(cwd, ".env"));
      expect(JSON.parse(run(["doctor", "--json"], {}, runtime).out).settingsPath).toBe(report.settingsPath);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("key-isolation doctor inspects both keys and starts neither reader", () => {
    const argv = [fixtureRuntime, reader, "synthetic-argv-marker"];
    writeFileSync(settings, JSON.stringify({keyCommands:{gemini:argv,twelvelabs:argv}}), {mode:0o600});
    for (const runtime of ["node", "node-bare"]) {
      const report = run(["doctor","--json"], {FRAME_OF_MIND_KEY_COMMAND:"[]",FRAME_OF_MIND_TWELVELABS_KEY_COMMAND:"[]"}, runtime);
      const data = JSON.parse(report.out);
      expect(data.keys?.twelvelabs).toMatchObject({commandDisabledByEnvironment:true});
      expect(data.key).toEqual(data.keys.gemini);
      expect(report.out + report.err).not.toContain("synthetic-argv-marker");
      expect(existsSync(marker)).toBe(false);
    }
    const configured = JSON.parse(run(["doctor","--json"]).out);
    expect(configured.keys.twelvelabs).toMatchObject({source:"command",present:true,state:"unverified"});
    expect(existsSync(marker)).toBe(false);
  });

  const calibrate = ["calibrate", "--model", "!"];
  const missing = {exit: 10, out: '{"schemaVersion":1,"error":{"code":"KEY_MISSING","message":"key missing."}}\n', err: ""};
  const refused = {exit: 10, out: '{"schemaVersion":1,"error":{"code":"KEY_REFUSED","message":"key refused.","details":{"reason":"key-command"}}}\n', err: ""};
  const disabled = {FRAME_OF_MIND_KEY_COMMAND: "[]", OBSERVE_ACCOUNT: "1"};
  function configureReader() {
    writeFileSync(settings, JSON.stringify({keyCommand: [fixtureRuntime, reader]}), {mode: 0o600});
  }

  it("skips the account file and reports a missing key for an empty selector", () => {
    configureReader();
    writeFileSync(join(cwd, ".env"), "");
    expect(run([...calibrate, "--json"], disabled)).toEqual(missing);
    expect(JSON.parse(run(["doctor", "--json"], disabled).out).key.source).toBe("none");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "unexpected-open"))).toBe(false);
    expect(JSON.parse(run([...calibrate, "--json"]).out).error.code).toBe("USAGE");
    expect(readFileSync(marker, "utf8")).toBe("start\n");
  });

  it("uses the folder key after an empty selector", () => {
    configureReader();
    writeFileSync(join(cwd, "fixture.mp4"), fixtureMovieHeader());
    rmSync(join(cwd, "consumer-result"), {force: true});
    const report = run(["doctor", "--json"], disabled);
    expect(JSON.parse(report.out).key.source).toBe("dotenv");
    expect(report.exit).toBe(0);
    const result = run(["analyze", "--source", "none", "--video", "fixture.mp4", "--output", "folder-out",
      "--no-calibrate", "--no-screenshots", "--no-derived-transcript", "--json"],
      {...disabled, PATH: home, FIXTURE_ANSWER: "synthetic-folder", CONSUMER_FIXTURE: "1"});
    expect(JSON.parse(result.out).error.code).toBe("PROVIDER_REFUSED");
    expect(readFileSync(join(cwd, "consumer-result"), "utf8")).toBe("accepted");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "unexpected-open"))).toBe(false);
  });

  describe.each(["node-bare", "bun-bare"])("empty selector under %s", runtime => {
    it.each(["folder", "environment"])("uses only the merged key with an empty selector from the %s", origin => {
      configureReader();
      writeFileSync(join(cwd, ".env"), origin === "folder" ? "FRAME_OF_MIND_KEY_COMMAND=[]" : "");
      const env = {...(origin === "environment" && disabled), OBSERVE_FOLDER: "1", OBSERVE_ACCOUNT: "1"};
      expect(run([...calibrate, "--json"], env, runtime)).toEqual(missing);
      const keyed = run([...calibrate, "--json"], {...env, GEMINI_API_KEY: "synthetic"}, runtime);
      expect(JSON.parse(keyed.out).error.code).toBe("USAGE");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(root, "unexpected-open"))).toBe(false);
    });
  });

  describe.each(["node", "node-bare"])("doctor under %s", runtime => {
    it.each([true, false])("explains the disabled key command with a present key = %s", present => {
      configureReader();
      writeFileSync(join(cwd, ".env"), "");
      const env = {...disabled, ...(present && {GEMINI_API_KEY: "synthetic"})};
      const line = "Key command switched off by FRAME_OF_MIND_KEY_COMMAND.";
      const text = run(["doctor"], env, runtime);
      expect(text.out.split("\n").filter(value => value === line)).toEqual([line]);
      const json = run(["doctor", "--json"], env, runtime);
      const key = validateCliDocument("doctor", json.out).key;
      expect(key).toMatchObject({commandDisabledByEnvironment: true, present,
        source: present ? (runtime === "node" ? "environment" : "unknown") : "none"});
      expect([text.exit, json.exit]).toEqual(present ? [0, 0] : [1, 1]);
      expect(existsSync(join(root, "unexpected-open"))).toBe(false);
      const control = {GEMINI_API_KEY: "synthetic"};
      expect(run(["doctor"], control, runtime).out).not.toContain(line);
      expect(validateCliDocument("doctor", run(["doctor", "--json"], control, runtime).out).key)
        .not.toHaveProperty("commandDisabledByEnvironment");
      expect(existsSync(marker)).toBe(false);
    });
  });

  it.each(["node-bare", "bun-bare"])("ignores folder and inherited selectors on a merged launch (%s)", runtime => {
    const selector = JSON.stringify([fixtureRuntime, reader]);
    for (const fromFolder of [true, false]) {
      writeFileSync(join(cwd, ".env"), fromFolder ? "FRAME_OF_MIND_KEY_COMMAND=" + selector : "");
      const env = fromFolder ? {} : {FRAME_OF_MIND_KEY_COMMAND: selector};
      expect(run([...calibrate, "--json"], env, runtime)).toEqual(refused);
      // Model validation follows key acquisition and precedes media or provider calls.
      const keyed = run([...calibrate, "--json"], {...env, GEMINI_API_KEY: "synthetic"}, runtime);
      expect(JSON.parse(keyed.out).error.code).toBe("USAGE");
      expect(existsSync(marker)).toBe(false);
    }
  }, 30_000);

  it.each(["node-bare", "bun-bare"])("uses a settings reader only on the clean control (%s)", runtime => {
    writeFileSync(join(cwd, ".env"), "");
    expect(run([...calibrate, "--json"], {}, runtime)).toEqual(missing);
    writeFileSync(settings, JSON.stringify({keyCommand: [fixtureRuntime, reader]}), {mode: 0o600});
    expect(run([...calibrate, "--json"], {}, runtime)).toEqual(refused);
    expect(run(calibrate, {}, runtime)).toEqual({exit: 10, out: "", err: "Key command unavailable.\n"});
    const doctor = run(["doctor"], {}, runtime);
    expect(doctor.exit).toBe(1);
    expect(doctor.out).toContain("not run under this launcher");
    expect(doctor.out.split("\n").filter(line => line.startsWith("Next step:")))
      .toEqual(["Next step: Run the installed Node command."]);
    expect(existsSync(marker)).toBe(false);
    const control = run([...calibrate, "--json"], {}, runtime === "node-bare" ? "node" : "bun-clean");
    expect(JSON.parse(control.out).error.code).toBe("USAGE");
    expect(readFileSync(marker, "utf8")).toBe("start\n");
  }, 30_000);

  it("refuses a settings file whose opened handle has a foreign owner", () => {
    writeFileSync(settings, "{}", {mode: 0o600});
    const result = run(["doctor", "--json"], {FOREIGN_FILE: "1", OBSERVE_FOLDER: "1"});
    expect(JSON.parse(result.out).key).toMatchObject({source: "command", present: false, state: "unavailable"});
    expect(existsSync(join(root, "unexpected-open")), "refused source opened folder file").toBe(false);
  });

  it("doctor inspects permissions without starting the reader", () => {
    writeFileSync(settings, JSON.stringify({keyCommand: [fixtureRuntime, reader]}), {mode: 0o600});
    const healthy = run(["doctor", "--json"], {PATH: ""});
    expect(healthy.exit).toBe(0);
    const report = JSON.parse(healthy.out);
    expect(report.key).toMatchObject({present: true, source: "command", state: "unverified"});
    expect(report.checks).toContainEqual({name: "provider_key", required: true, ok: true, detail: "configured"});
    const text = run(["doctor"], {PATH: ""});
    expect(text.out.split("\n")).toContain("ok GEMINI_API_KEY (key command, not run by doctor)");
    expect(text.out).toContain(settings);
    expect(text.out).not.toContain("Next step");
    expect(existsSync(marker)).toBe(false);
  });

  it.each(["command", "settings"])("doctor prints the mode repair for %s", kind => {
    const unsafe = join(home, "unsafe reader");
    writeFileSync(unsafe, "#!/usr/bin/env bash\nexit 1\n", {mode: 0o700});
    const isCommand = kind === "command";
    const path = isCommand ? unsafe : settings;
    writeFileSync(settings, JSON.stringify({keyCommand: isCommand ? [unsafe] : [fixtureRuntime, reader]}), {mode: 0o600});
    chmodSync(path, isCommand ? 0o722 : 0o644);
    const invalid = run(["doctor"]);
    expect(invalid.exit).toBe(1);
    const fix = isCommand ? "chmod go-w" : "chmod 600";
    const lines = invalid.out.trimEnd().split("\n");
    expect(lines.filter(s => s.startsWith("Next step"))).toEqual(["Next step: Run " + fix + " '" + path + "'."]);
    expect(lines.at(-1)).toBe(lines.find(s => s.startsWith("Next step")));
    const json = run(["doctor", "--json"]);
    expect(json.exit).toBe(1);
    expect(JSON.parse(json.out).key).toMatchObject({present: false, source: "command", state: "unavailable"});
    expect(existsSync(marker)).toBe(false);
  });
  it.each([["--help"], ["--version"], ["recipes"], ["key", "set"], ["mcp", "--json"],
    ...["analyze", "transcribe"].flatMap(family => operations.filter(op => family === "analyze" || op !== "dry-run")
      .map(op => [family, op, "fixture", "--json", "--out", "missing"]))])("inspection leaves the reader idle (%#)", (...args) => {
    run(args, {FRAME_OF_MIND_KEY_COMMAND: JSON.stringify([fixtureRuntime, reader])});
    expect(existsSync(marker)).toBe(false);
  });
  it("runs an env shebang reader from the installed Node entry", () => {
    const script = join(home, "reader");
    writeFileSync(script, "#!/usr/bin/env bash\nexec printenv FIXTURE_ANSWER\n", {mode: 0o700});
    writeFileSync(settings, JSON.stringify({keyCommand: [script]}), {mode: 0o600});
    writeFileSync(join(cwd, "fixture.mp4"), fixtureMovieHeader());
    rmSync(join(cwd, "consumer-result"), {force: true});
    const result = run(["analyze", "--source", "none", "--video", "fixture.mp4", "--output", "script-out",
      "--no-calibrate", "--no-screenshots", "--no-derived-transcript", "--json"], {
      PATH: "/usr/bin:/bin", FIXTURE_ANSWER: "synthetic-script-answer", CONSUMER_FIXTURE: "1",
    }, "node", 20_000);
    expect(JSON.parse(result.out).error.code).toBe("PROVIDER_REFUSED");
    expect(readFileSync(join(cwd, "consumer-result"), "utf8")).toBe("accepted");
  }, 20_000);

  it("delivers accepted answers with identical public streams, traces and run artifacts", () => {
    const trace = join(cwd, "trace.jsonl");
    const telemetry = join(build, "dist/telemetry.js");
    const original = readFileSync(telemetry, "utf8");
    const capture = `
      import {appendFileSync} from "node:fs";
      function record(value) { appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + "\\n"); }
      export function cliAnalysisTracer() {
        return {span(description, work) { record(description); return work({setAttributes: record}); }};
      }
      export function captureCliException(...args) { record(args); }
      export function flushCliTelemetry() {}
      export function isCliTelemetryEnabled() { return true; }
    `;
    const output = join(cwd, "out");
    const module = join(home, "answer.mjs");
    writeFileSync(module, "process.stdout.write(process.env.FIXTURE_ANSWER)");
    writeFileSync(join(cwd, "fixture.mp4"), fixtureMovieHeader());
    const observe = (answer: string) => {
      rmSync(output, {recursive: true, force: true});
      rmSync(trace, {force: true});
      rmSync(join(cwd, "consumer-result"), {force: true});
      const streams = run(["analyze", "--source", "none", "--video", "fixture.mp4", "--output", output,
        "--no-calibrate", "--no-screenshots", "--no-derived-transcript", "--json"], {
        FRAME_OF_MIND_KEY_COMMAND: JSON.stringify([fixtureRuntime, module]), FIXTURE_ANSWER: answer, CONSUMER_FIXTURE: "1", PATH: home,
      });
      expect(existsSync(join(cwd, "consumer-result")), "local consumer called").toBe(true);
      expect(readFileSync(join(cwd, "consumer-result"), "utf8")).toBe("accepted");
      const files = readdirSync(output, {recursive: true, withFileTypes: true}).filter(file => file.isFile());
      expect(files.length).toBeGreaterThan(0);
      const artifacts = files.map(file => [file.name, readFileSync(join(file.parentPath, file.name), "utf8")]);
      const spans = readFileSync(trace, "utf8");
      expect(spans).toContain("stage upload");
      const result = {streams, artifacts, spans};
      expect(JSON.stringify(result)).not.toContain(answer);
      return result;
    };
    try {
      writeFileSync(telemetry, capture);
      expect(observe("short-fixture-answer")).toEqual(observe("longer-and-unrelated-fixture-answer"));
    } finally { writeFileSync(telemetry, original); }
  });

  it("refuses in fixed public bytes without opening the folder or publishing an artifact", () => {
    const failure = join(home, "refuse.mjs");
    writeFileSync(failure, "process.stderr.write(process.argv[2]); process.exitCode = 1");
    for (const value of ["synthetic", "unrelated-longer-value"]) {
      const argv = [fixtureRuntime, failure, value];
      const env = {FRAME_OF_MIND_KEY_COMMAND: JSON.stringify(argv), OBSERVE_FOLDER: "1", PATH: ""};
      const before = readdirSync(cwd);
      const args = ["analyze", "--output", "out", "--source", "none", "--video", "absent.mp4"];
      expect(run(args, env)).toEqual({exit: 10, out: "", err: "Key command unavailable.\n"});
      const json = run([...args, "--json"], env);
      expect(json).toEqual({exit: 10, out: '{"schemaVersion":1,"error":{"code":"KEY_REFUSED","message":"key refused.","details":{"reason":"key-command"}}}\n', err: ""});
      expect(readdirSync(cwd)).toEqual(before);
      expect(existsSync(join(root, "unexpected-open")), "folder file accessed after command selected").toBe(false);
    }
  });
});

describe("key-isolation", () => {
  it("keeps both synthetic keys and selectors away from readers, helpers and openers",async()=>{
    const {childEnvironment,keyCommandEnvironment}=await import("../src/lib/child-env.js");
    const {spawnSync}=await import("node:child_process");
    const launch={GEMINI_API_KEY:"synthetic-first",TWELVELABS_API_KEY:"synthetic-second",
      FRAME_OF_MIND_KEY_COMMAND:'["/synthetic-first"]',FRAME_OF_MIND_TWELVELABS_KEY_COMMAND:'["/synthetic-second"]'};
    for(const env of [keyCommandEnvironment(launch),keyCommandEnvironment(launch),childEnvironment("media",launch),childEnvironment("opener",launch)]) {
      const child=spawnSync(process.execPath,["-p","JSON.stringify(Object.keys(process.env))"],{env,encoding:"utf8"});
      expect(child.status).toBe(0);
      for(const name of Object.keys(launch)) expect(JSON.parse(child.stdout)).not.toContain(name);
    }
  });
});
