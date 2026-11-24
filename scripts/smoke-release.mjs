import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const cwd = await mkdtemp(join(tmpdir(), "frameofmind-consumer-"));
try {
  await copyFile(process.argv[2] ?? "release/frameofmind.mjs", join(cwd, "frameofmind.mjs"));
  function run(arg, expectedStatus) {
    const result = spawnSync(process.execPath, ["frameofmind.mjs", arg], {
      cwd, env: { HOME: cwd, PATH: "", SystemRoot: process.env.SystemRoot }, encoding: "utf8",
    });
    if (result.error) throw result.error;
    assert.equal(result.status, expectedStatus, `${arg} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }
  assert.equal(run("--version", 0).trim(), version, "bundle version differs from package version");
  assert.match(run("--help", 0), /^Usage: frameofmind/m);
  const unsupported = spawnSync(process.execPath, ["frameofmind.mjs", "mcp"], { cwd, env: { HOME: cwd, PATH: "" }, encoding: "utf8" });
  assert.equal(unsupported.status, 1);
  assert.equal(unsupported.stdout, "");
  assert.match(unsupported.stderr, /^bun_required: use bun --no-env-file/m);
  const doctor = run("doctor", 1);
  assert.match(doctor, /^ok Node >=22$/m);
  assert.match(doctor, /^-- GEMINI_API_KEY$/m);
  assert.match(doctor, /^Telemetry: off$/m);
  console.log(`RELEASE_SMOKE version=${version} status=PASS`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
