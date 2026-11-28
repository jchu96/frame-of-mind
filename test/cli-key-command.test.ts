import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCliFixture } from "./helpers/cli-build.js";
import { operations } from "../src/job-invocation.js";

describe.skipIf(process.platform === "win32")("CLI key command", () => {
  let root: string, home: string, cwd: string, settings: string, reader: string, marker: string, build: string, preload: string;
  const source = resolve("src/cli.ts");
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
    reader = join(home, "reader");
    for (const path of [settings, decoyFile]) mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    for (const path of [reader, join(decoy, "reader")]) writeFileSync(path,
      '#!/bin/sh\necho start >> "' + marker + '"\nprintf %s synthetic', {mode: 0o700});
    writeFileSync(decoyFile, JSON.stringify({keyCommand: [join(decoy, "reader")]}), {mode: 0o600});
    const roots = ["HOME", "XDG_CONFIG_HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"];
    writeFileSync(join(cwd, ".env"), [...roots.map(name => name + "=" + decoy),
      "FRAME_OF_MIND_KEY_COMMAND=" + JSON.stringify([join(decoy, "reader")]), "GEMINI_API_KEY=synthetic-folder"].join("\n"));
    preload = join(root, "account.cjs");
    writeFileSync(preload, `
      const os = require('node:os'), fs = require('node:fs');
      os.userInfo = () => ({homedir: ${JSON.stringify(home)}});
      const original = fs.openSync;
      fs.openSync = function(path, ...args) {
        if (String(path).startsWith(${JSON.stringify(decoy)}) || (process.env.OBSERVE_FOLDER && path === ${JSON.stringify(join(cwd, ".env"))})) {
          fs.appendFileSync(${JSON.stringify(join(root, "unexpected-open"))}, "open\\n");
        }
        return original(path, ...args);
      };
      require('node:module').syncBuiltinESMExports();
      global.fetch = () => { throw Error('offline fixture'); };
    `);
  }, 60_000);
  afterAll(() => {
    if (build) rmSync(build, {recursive: true, force: true});
    if (root) rmSync(root, {recursive: true, force: true});
  });
  function run(args: string[], env: NodeJS.ProcessEnv = {}, runtime = "node") {
    const node = runtime.startsWith("node");
    const entry = node ? join(build, "dist/cli.js") : source;
    const flags = node ? ["--require", preload, ...(runtime === "node-bare" ? ["--env-file=.env"] : [])]
      : runtime === "bun-clean" ? ["--no-env-file"] : [];
    const result = spawnSync(node ? process.execPath : "bun", [...flags, entry, ...args], {
      cwd, env: {PATH: process.env.PATH, HOME: home, TMPDIR: root, ...env}, timeout: 8000, encoding: "utf8",
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
      writeFileSync(settings, JSON.stringify({keyCommand: [reader]}), {mode: 0o600});
      run(["calibrate", "--model", "invalid"], {FRAME_OF_MIND_KEY_COMMAND: JSON.stringify([reader])}, runtime);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("doctor inspects permissions and prints exactly one repair for a mode fault", () => {
    writeFileSync(settings, JSON.stringify({keyCommand: [reader]}), {mode: 0o600});
    const healthy = run(["doctor", "--json"], {PATH: ""});
    expect(healthy.exit).toBe(0);
    const report = JSON.parse(healthy.out);
    expect(report.key).toMatchObject({present: true, source: "command", state: "unverified"});
    expect(report.checks).toContainEqual({name: "provider_key", required: true, ok: true, detail: "configured"});
    const text = run(["doctor"], {PATH: ""});
    expect(text.out.split("\n")).toContain("ok GEMINI_API_KEY (key command, not run by doctor)");
    expect(text.out).toContain(settings);
    expect(text.out).not.toContain("Next step");
    for (const [path, mode, fix] of [[reader, 0o722, "chmod go-w"], [settings, 0o644, "chmod 600"]] as const) {
      try {
        chmodSync(path, mode);
        const invalid = run(["doctor"], {PATH: ""});
        expect(invalid.exit).toBe(1);
        expect(invalid.out.trimEnd().split("\n").filter(s => s.startsWith("Next step"))).toEqual(["Next step: Run " + fix + " '" + path + "'."]);
        expect(JSON.parse(run(["doctor", "--json"], {PATH: ""}).out).key).toMatchObject({present: false, source: "command", state: "unavailable"});
      } finally { chmodSync(path, path === reader ? 0o700 : 0o600); }
    }
    expect(existsSync(marker)).toBe(false);
  });
  it.each([["--help"], ["--version"], ["recipes"], ["key", "set"], ["mcp", "--json"],
    ...["analyze", "transcribe"].flatMap(family => operations.filter(op => family === "analyze" || op !== "dry-run")
      .map(op => [family, op, "fixture", "--json", "--out", "missing"]))])("inspection leaves the reader idle (%#)", (...args) => {
    run(args, {FRAME_OF_MIND_KEY_COMMAND: JSON.stringify([reader])});
    expect(existsSync(marker)).toBe(false);
  });
  it("refuses in fixed public bytes without opening the folder or publishing an artifact", () => {
    for (const value of ["synthetic", "unrelated-longer-value"]) {
      const argv = ["/bin/sh", "-c", 'printf %s "$1" >&2; exit 1', "reader", value];
      const env = {FRAME_OF_MIND_KEY_COMMAND: JSON.stringify(argv), OBSERVE_FOLDER: "1", PATH: ""};
      const args = ["analyze", "--source", "none", "--video", "absent.mp4"];
      expect(run(args, env)).toEqual({exit: 10, out: "", err: "Key command unavailable.\n"});
      const json = run([...args, "--json"], env);
      expect(json).toEqual({exit: 10, out: '{"schemaVersion":1,"error":{"code":"KEY_REFUSED","message":"key refused."}}\n', err: ""});
      expect(existsSync(join(root, "unexpected-open")), "folder file accessed after command selected").toBe(false);
    }
  });
});
