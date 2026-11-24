import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { resolves, validateCliDocument } from "./helpers/cli-schema.js";

const entry = resolve("src/cli.ts");
const examples = resolve("test/fixtures/contract-consumer");
const root = mkdtempSync(join(tmpdir(), "cli-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// Resolve Bun before isolating PATH from external tools and credentials.
const executable = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }).stdout;

function run(args: string[], key = "") {
  const result = spawnSync(executable, ["--no-env-file", entry, ...args], {
    cwd: root, env: { HOME: root, TMPDIR: root, PATH: "", GEMINI_API_KEY: key, SystemRoot: process.env.SystemRoot },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

it.each(readdirSync(examples).filter(name => /^0[1-3]-/.test(name)))("serves every consumer pointer in %s", file => {
  const { argv, reads } = JSON.parse(readFileSync(join(examples, file), "utf8"));
  const result = run([...argv, "--json"]);
  expect(result.status, result.stderr).toBe(0);
  const document = JSON.parse(result.stdout);
  for (const pointer of reads) expect(resolves(document, pointer.slice(1).split("/")), `missing consumer pointer ${pointer}`).toBe(true);
  const name = argv[0].replace(/^--/, "");
  validateCliDocument(name, result.stdout);
  if (name === "doctor") {
    expect(document.ok).toBe(false);
    expect(document.key.present).toBe(false);
    expect(document.commit).toBeNull();
    expect(document.cliSha256).toBeNull();
    const ready = run([...argv, "--json"], "fixture");
    expect(ready.status, ready.stderr).toBe(0);
    const healthy = JSON.parse(ready.stdout);
    expect(healthy.ok).toBe(true);
    expect(healthy.checks.filter((row: { required: boolean }) => row.required).map((row: { name: string }) => row.name))
      .toEqual(["node", "provider_key"]);
  }
});

it("advertises the machine commands and options that ship schemas", () => {
  const result = run(["capabilities", "--json"]);
  expect(result.status, result.stderr).toBe(0);
  const inventory = validateCliDocument("capabilities", result.stdout);
  expect(Object.keys(inventory.schemaVersions).sort()).toEqual(readdirSync("schemas/cli").map(name => name.replace(".schema.json", "")).sort());
  expect(inventory.commands.map((cmd: {name: string}) => cmd.name).sort()).toEqual(Object.keys(inventory.schemaVersions).sort());
  expect(JSON.parse(run(["--version", "--schema-version=1", "--json"]).stdout).schemaVersions).toEqual(inventory.schemaVersions);
  for (const versions of Object.values(inventory.schemaVersions)) expect(versions).toEqual([1]);
  expect(inventory.commands.flatMap((cmd: {options: string[]}) => cmd.options)).not.toContain("--force");
  expect(inventory.commands).toContainEqual({ name: "doctor", options: ["--scratch", "--remove", "--json", "--schema-version"] });
});

it.each([
  [["recipes", "--json", "--unknown"], "USAGE", 2],
  [["--version", "--json", "--unknown"], "USAGE", 2],
  [["doctor", "--remove", "--json"], "USAGE", 2],
  [["doctor", "--json", "--scratch", "../scratch"], "PATH_OUTSIDE_ROOTS", 11],
  [["calibrate", "--json"], "KEY_MISSING", 10],
  [["recipes", "--json", "--schema-version", "2"], "UNKNOWN_SCHEMA", 21],
  [["mcp", "--json"], "USAGE", 2],
  [["key", "set", "--json"], "USAGE", 2],
] as const)("refuses %j with %s", (args, code, status) => {
  const result = run([...args]);
  expect(result.status, result.stderr).toBe(status);
  expect(result.stdout, "one stdout failure document").toMatch(/^\{[^\n]+\}\n$/);
  const document = validateCliDocument("recipes", result.stdout);
  expect(document).toEqual({ schemaVersion: 1, error: { code, message: expect.any(String) } });
  expect(result.stderr).toBe("");
});

it("validates a timeline lookup without opening source media", () => {
  const result = run(["map", resolve("test/fixtures/timeline-export-23976.otio"), "--at", "99999f", "--json"]);
  expect(result.status, result.stderr).toBe(0);
  const report = validateCliDocument("map", result.stdout);
  expect(report.rows).toEqual([{status: "outside the sequence"}]);
  report.rows[0] = { status: "future finding", future: { count: 1 } };
  validateCliDocument("map", JSON.stringify(report));
});

it("validates the calibration receipt with a stand-in measurement", async () => {
  const { program } = await import("../src/cli.js");
  const calibration = await import("../src/adapters/gemini-calibration.js");
  const media = await import("../src/services/media-capabilities.js");
  vi.stubEnv("GEMINI_API_KEY", "fixture");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    vi.spyOn(media, "requireMedia").mockResolvedValue();
    vi.spyOn(calibration, "calibrateClipClock").mockResolvedValue({
      model: "gemini-test", checkedAt: "2026-01-01T00:00:00Z", result: "relative",
      evidence: { flashFileSeconds: 27, clipStartSeconds: 20, reportedSeconds: 7 },
    });
    await program.parseAsync(["calibrate", "--json"], { from: "user" });
    validateCliDocument("calibrate", stdout.mock.calls.map(([chunk]) => chunk).join(""));
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
