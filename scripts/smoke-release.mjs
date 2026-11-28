import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const cwd = await realpath(await mkdtemp(join(tmpdir(), "frameofmind-consumer-")));
try {
  const bundle = process.argv[2] ?? "release/frameofmind.mjs";
  await copyFile(bundle, join(cwd, "frameofmind.mjs"));
  const account = join(cwd, "account.cjs");
  await writeFile(account, `
    const os = require("node:os");
    os.userInfo = () => ({homedir: ${JSON.stringify(cwd)}});
    require("node:module").syncBuiltinESMExports();
    globalThis.fetch = async (_url, init) => {
      const accepted = new Headers(init.headers).get("x-goog-api-key") === "synthetic-command-fixture";
      require("node:fs").writeFileSync("consumer-result", accepted ? "accepted" : "wrong source");
      return new Response(null, {status: 403});
    };
  `);
  function run(args, expectedStatus, options = [], env = {}, timeout) {
    const result = spawnSync(process.execPath, ["--require", account, ...options, "frameofmind.mjs", ...args], {
      cwd, timeout, env: { HOME: cwd, PATH: "", SystemRoot: process.env.SystemRoot, ...env }, encoding: "utf8",
    });
    if (result.error) throw result.error;
    assert.equal(result.status, expectedStatus, `${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }
  assert.equal(run(["--version"], 0).trim(), version, "bundle version differs from package version");
  assert.match(run(["--help"], 0), /^Usage: frameofmind/m);
  const unsupported = spawnSync(process.execPath, ["frameofmind.mjs", "mcp"], { cwd, env: { HOME: cwd, PATH: "" }, encoding: "utf8" });
  assert.equal(unsupported.status, 20);
  assert.equal(unsupported.stdout, "");
  assert.match(unsupported.stderr, /^BUN_REQUIRED: use bun --no-env-file/m);
  const report = JSON.parse(run(["doctor", "--json"], 0));
  assert.equal(report.schemaVersion, 1, "UNKNOWN_SCHEMA");
  assert.equal(report.ok, false);
  const metadata = JSON.parse(await readFile(join(dirname(bundle), "release.json"), "utf8"));
  assert.equal(report.commit, metadata.commit);
  assert.equal(report.cliSha256, createHash("sha256").update(await readFile(bundle)).digest("hex"));
  const doctor = run(["doctor"], 1);
  assert.match(doctor, /^ok Node >=22$/m);
  assert.match(doctor, /^-- GEMINI_API_KEY \(none\)$/m);
  assert.match(doctor, /^Telemetry: off$/m);
  await writeFile(join(cwd, ".env"), "GEMINI_API_KEY=synthetic-release-fixture\n");
  const selected = JSON.parse(run(["doctor", "--json"], 0)).key;
  assert.deepEqual(selected, {present: true, source: "dotenv", path: join(cwd, ".env")});
  assert.ok(run(["doctor"], 0).includes("ok GEMINI_API_KEY (" + JSON.stringify(selected.path) + ")\n"));
  const preloaded = JSON.parse(run(["doctor", "--json"], 0, ["--require", "node:path"]));
  assert.deepEqual(preloaded.key, selected);
  const bare = ["--env-file=.env"];
  assert.deepEqual(JSON.parse(run(["doctor", "--json"], 0, bare)).key, {present: true, source: "unknown"});
  assert.match(run(["doctor"], 0, bare), /^ok GEMINI_API_KEY \(unknown: started with --env-file\)$/m);
  const refused = JSON.parse(run(["analyze", "start", "clip.mp4", "--json"], 2, bare));
  assert.deepEqual(refused, {schemaVersion: 1, error: {code: "USAGE", message: "Invalid command arguments."}});
  if (process.platform === "darwin" || process.platform === "linux") {
    const settings = join(cwd, process.platform === "darwin" ? "Library/Application Support" : ".config", "frameofmind/settings.json");
    const tools = join(cwd, "tools");
    await mkdir(dirname(settings), {recursive: true, mode: 0o700});
    await mkdir(tools, {mode: 0o700});
    const reader = join(tools, "fixture-reader");
    await writeFile(reader, '#!/usr/bin/env bash\nexec printenv FIXTURE_SESSION\n', {mode: 0o700});
    await symlink("/usr/bin/printenv", join(tools, "printenv"));
    await writeFile(settings, JSON.stringify({keyCommand: [reader]}), {mode: 0o600});
    await writeFile(join(cwd, "fixture.mp4"), "synthetic recording");
    const args = ["analyze", "--source", "none", "--video", "fixture.mp4", "--output", "out",
      "--no-calibrate", "--no-screenshots", "--no-derived-transcript", "--json"];
    run(args, 1, [], {PATH: tools + ":/usr/bin:/bin", FIXTURE_SESSION: "synthetic-command-fixture"}, 20_000);
    assert.equal(await readFile(join(cwd, "consumer-result"), "utf8"), "accepted");
    console.log("RELEASE_KEY_COMMAND local_consumer=PASS");
  }
  console.log(`RELEASE_SMOKE version=${version} status=PASS`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
