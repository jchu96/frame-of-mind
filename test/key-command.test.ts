import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliSettings } from "../src/cli-settings.js";
import { keyCommandEnvironment } from "../src/lib/child-env.js";
import { runKeyCommand, KEY_COMMAND_TIMEOUT_MS, KEY_COMMAND_MAX_BYTES } from "../src/key-command.js";

describe.skipIf(process.platform === "win32")("operator key reader", () => {
  let home: string, settings: string, reader: string, invoked: string, cwd: string;
  const folder = vi.fn(() => "GEMINI_API_KEY=synthetic-fallback");
  const token = "synthetic-answer";
  function script(body: string) {
    writeFileSync(reader, "#!/usr/bin/env bash\n" + body + "\n", {mode: 0o700});
  }
  function config(environment: NodeJS.ProcessEnv = {}, mode: "bare" | "clean" = "clean", platform = process.platform) {
    return createCliSettings({environment: {PATH: "/usr/bin:/bin", ...environment}, cwd, mode, accountHome: home}, folder, platform);
  }
  function select(...args: string[]) { return {FRAME_OF_MIND_KEY_COMMAND: JSON.stringify(args)}; }
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "key-command-")));
    cwd = join(home, "work");
    mkdirSync(cwd);
    settings = join(home, process.platform === "darwin" ? "Library/Application Support" : ".config", "frameofmind/settings.json");
    mkdirSync(dirname(settings), {recursive: true, mode: 0o700});
    reader = join(home, "fixture reader");
    invoked = join(home, "starts");
    script('echo start >> starts\nprintf %s synthetic-answer');
    folder.mockClear();
  });
  afterEach(() => rmSync(home, {recursive: true, force: true}));

  it("uses only the clean launch selector and account location, including from home", async () => {
    writeFileSync(settings, JSON.stringify({keyCommand: [reader]}), {mode: 0o600});
    cwd = home;
    const decoy = select(join(cwd, "decoy"));
    vi.stubEnv("FRAME_OF_MIND_KEY_COMMAND", decoy.FRAME_OF_MIND_KEY_COMMAND);
    try {
      const clean = config({HOME: cwd, XDG_CONFIG_HOME: join(home, "decoy")});
      expect(await clean.providerKey()).toBe(token);
      for (const env of [{}, select(reader)]) {
        const bare = config(env, "bare");
        expect(bare.keyReport()).toEqual({present: false, source: "unknown"});
        expect(await bare.providerKey()).toBeUndefined();
      }
      expect(readFileSync(invoked, "utf8")).toBe("start\n");
      expect(folder).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it("refuses unsafe files, commands and malformed settings before fallback", async () => {
    async function refuses(environment: NodeJS.ProcessEnv = {}) {
      const cli = config(environment);
      expect(cli.keyReport()).toMatchObject({present: false, source: "command", state: "unavailable"});
      await expect(Promise.resolve().then(() => cli.providerKey())).rejects.toMatchObject({code: "KEY_REFUSED", message: "Key command unavailable."});
      expect(folder).not.toHaveBeenCalled();
      expect(existsSync(invoked)).toBe(false);
    }
    for (const value of ["", "{}", "[]", "[2]", '["reader"]', JSON.stringify([join(home, "missing")]), JSON.stringify([home])]) {
      await refuses({FRAME_OF_MIND_KEY_COMMAND: value});
    }
    for (const raw of ["{", "null", '{"extra":1}', '{"keyCommand":[]}', '{"keyCommand":false}',
      '{"keyCommand":[],"key\\u0043ommand":' + JSON.stringify([reader]) + '}']) {
      writeFileSync(settings, raw, {mode: 0o600});
      await refuses();
    }
    writeFileSync(settings, JSON.stringify({keyCommand: [reader]}));
    chmodSync(settings, 0o644);
    await refuses();
    chmodSync(settings, 0o600);
    chmodSync(dirname(settings), 0o750);
    await refuses();
    chmodSync(dirname(settings), 0o700);
    rmSync(settings);
    symlinkSync(join(home, "absent"), settings);
    await refuses();
    const link = join(home, "link");
    symlinkSync(reader, link);
    for (const mode of [0o600, 0o720, 0o702]) {
      chmodSync(reader, mode);
      await refuses(select(link));
    }
    chmodSync(reader, 0o700);
    expect(await config(select(link)).providerKey()).toBe(token);
  });

  it("refuses a foreign settings owner", async () => {
    writeFileSync(settings, JSON.stringify({keyCommand: [reader]}), {mode: 0o600});
    const uid = vi.spyOn(process, "geteuid").mockReturnValue(process.geteuid!() + 1);
    try { expect(config().keyReport()).toMatchObject({source: "command", state: "unavailable"}); }
    finally { uid.mockRestore(); }
  });

  it("ignores settings on native Windows and refuses its selector", async () => {
    writeFileSync(settings, "invalid", {mode: 0o600});
    expect(await config({}, "clean", "win32").providerKey()).toBe("synthetic-fallback");
    expect(config({Frame_Of_Mind_Key_Command: "[]"}, "clean", "win32").keyReport()).toMatchObject({source: "command", state: "unavailable"});
  });

  it("starts the resolved program with literal arguments, closed input and the launch environment", async () => {
    const link = join(home, "link");
    symlinkSync(reader, link);
    const args = ["two words", "$", ";", "*", "`"];
    const session = {PATH: "/usr/bin:/bin", SESSION: "operator"};
    const environment = {...session, ...select(link, ...args)};
    expect(keyCommandEnvironment({...environment, GEMINI_API_KEY: "fixture", GRANOLA_API_KEY: "fixture"}))
      .toEqual(session);
    writeFileSync(reader, "#!" + process.execPath + "\n" + `
      const fs = require("node:fs");
      fs.writeFileSync("observed", JSON.stringify([process.argv.slice(1), process.cwd(), fs.readFileSync(0).length, process.env]));
      process.stdout.write("synthetic-answer");
    `);
    expect(await config({...environment, GRANOLA_API_KEY: "context-fixture"}).providerKey()).toBe(token);
    // Compare the same interpreter: on macOS Node adds its own CoreFoundation
    // encoding variable even when exec receives an empty environment.
    const control = JSON.parse(execFileSync(process.execPath, ["-p", "JSON.stringify(process.env)"], {env: session, encoding: "utf8"}));
    expect(JSON.parse(readFileSync(join(home, "observed"), "utf8")))
      .toEqual([[reader, ...args], home, 0, control]);
    expect(await config({...environment, GEMINI_API_KEY: "synthetic-inherited"}).providerKey()).toBe("synthetic-inherited");
    expect(folder).not.toHaveBeenCalled();
  });

  it("accepts only one printable token within the combined raw byte budget on clean exit", async () => {
    expect([KEY_COMMAND_TIMEOUT_MS, KEY_COMMAND_MAX_BYTES]).toEqual([30_000, 4096]);
    for (const output of ["synthetic", "synthetic\n", "synthetic\r\n", "x".repeat(4096)]) {
      script("printf %s " + JSON.stringify(output).replaceAll("\\n", "\n").replaceAll("\\r", "\r"));
      expect(await config(select(reader)).providerKey()).toBe(output.trimEnd());
    }
    for (const body of ["printf synthetic; exit 1", "printf synthetic; printf diagnostic >&2", "printf 'a\\nb\\n'",
      "printf '\\n'", "printf 'two words'", "printf '\\377'", "printf '%04097d' 0", "printf '%04096d' 0; printf x >&2"]) {
      script(body);
      const cli = config(select(reader));
      const provider = vi.fn();
      await expect(Promise.resolve().then(() => cli.providerKey()).then(provider)).rejects.toMatchObject({code: "KEY_REFUSED", message: "Key command unavailable."});
      expect(provider).not.toHaveBeenCalled();
      expect(folder).not.toHaveBeenCalled();
    }
  });

  it.each(["sleep 5", "while true; do printf x; sleep 0.05; done", "sleep 5 & exit 0"])("uses one deadline and ends the process group (%s)", async body => {
    const args: [string, ...string[]] = ["/bin/sh", "-c", "echo $$ > pid\n" + body];
    const started = performance.now();
    await expect(runKeyCommand(args, home, {PATH: "/usr/bin:/bin"}, 350)).rejects.toMatchObject({code: "KEY_REFUSED"});
    expect(performance.now() - started).toBeLessThan(1500);
    const pid = Number(readFileSync(join(home, "pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow(), {timeout: 1000});
  });

  it.each([false, true])("shares one acquisition and keeps public results independent of command bytes (%s)", async fail => {
    const reports = [];
    const before = process.env.GEMINI_API_KEY;
    for (const text of ["synthetic", "much-longer-synthetic"]) {
      script('echo start >> starts\nprintf %s "$1"' + (fail ? ' >&2; exit 2' : ''));
      const cli = config(select(reader, text));
      expect(cli.keyReport()).toMatchObject({present: true, source: "command", state: "unverified"});
      const read = async () => cli.providerKey();
      const both = await Promise.allSettled([read(), read()]);
      for (const result of [...both, ...(await Promise.allSettled([read()]))]) {
        if (fail) expect(result).toMatchObject({status: "rejected", reason: {code: "KEY_REFUSED", message: "Key command unavailable."}});
        else expect(result).toEqual({status: "fulfilled", value: text});
      }
      reports.push(cli.keyReport());
      expect(process.env.GEMINI_API_KEY).toBe(before);
    }
    expect(readFileSync(invoked, "utf8")).toBe("start\nstart\n");
    expect(reports[0]).toEqual(reports[1]);
    expect(reports[0]?.state).toBe(fail ? "unavailable" : "verified");
    expect(folder).not.toHaveBeenCalled();
  });
});
