import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const cwd = await mkdtemp(join(tmpdir(), "frameofmind-consumer-"));
try {
  const bundle = process.argv[2] ?? "release/frameofmind.mjs";
  await copyFile(bundle, join(cwd, "frameofmind.mjs"));
  function run(args, expectedStatus) {
    const result = spawnSync(process.execPath, ["frameofmind.mjs", ...args], {
      cwd, env: { HOME: cwd, PATH: "", SystemRoot: process.env.SystemRoot }, encoding: "utf8",
    });
    if (result.error) throw result.error;
    assert.equal(result.status, expectedStatus, `${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }
  assert.equal(run(["--version"], 0).trim(), version, "bundle version differs from package version");
  assert.match(run(["--help"], 0), /^Usage: frameofmind/m);
  const unsupported = spawnSync(process.execPath, ["frameofmind.mjs", "mcp"], { cwd, env: { HOME: cwd, PATH: "" }, encoding: "utf8" });
  assert.equal(unsupported.status, 1);
  assert.equal(unsupported.stdout, "");
  assert.match(unsupported.stderr, /^bun_required: use bun --no-env-file/m);
  const report = JSON.parse(run(["doctor", "--json"], 0));
  assert.equal(report.schemaVersion, 1, "UNKNOWN_SCHEMA");
  assert.equal(report.ok, false);
  const metadata = JSON.parse(await readFile(join(dirname(bundle), "release.json"), "utf8"));
  assert.equal(report.commit, metadata.commit);
  assert.equal(report.cliSha256, createHash("sha256").update(await readFile(bundle)).digest("hex"));
  const doctor = run(["doctor"], 1);
  assert.match(doctor, /^ok Node >=22$/m);
  assert.match(doctor, /^-- GEMINI_API_KEY$/m);
  assert.match(doctor, /^Telemetry: off$/m);
  console.log(`RELEASE_SMOKE version=${version} status=PASS`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
