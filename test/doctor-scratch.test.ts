import { once } from "node:events";
import { createInterface } from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { childEnvironment } from "../src/lib/child-env.js";
import { inspectScratch, markerName } from "../src/adapters/scratch.js";

function abandon(body: string, ...args: string[]) {
  const script = 'import {createScratch, createMediaLock} from "./src/adapters/scratch.ts";' + body;
  return execFileSync("bun", ["--no-env-file", "-e", script, ...args], {encoding: "utf8", env: childEnvironment("media")}).trim();
}

let root: string, scan: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "doctor-test-")));
  scan = join(root, "selected");
  await mkdir(scan);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("D01 keeps a same-named user folder without a marker", async () => {
  const folder = join(scan, ".settled-abc123");
  await mkdir(folder);
  const file = join(folder, "frame-001.png");
  await writeFile(file, "mine");
  const rows = await inspectScratch(scan, true);
  expect(await readFile(file, "utf8")).toBe("mine");
  expect(rows).toContainEqual(expect.objectContaining({path: folder, state: "unproven", removed: false}));
});

it("D02 keeps a marked folder while its creator is live", async () => {
  const child = spawn("bun", ["--no-env-file", "-e",
    'import {createScratch} from "./src/adapters/scratch.ts"; console.log(await createScratch("screenshots", process.argv[1])); setInterval(() => {}, 60000);', scan],
    {env: childEnvironment("media"), stdio: ["ignore", "pipe", "ignore"]});
  const exited = once(child, "exit");
  const lines = createInterface({input: child.stdout});
  try {
    const {value: folder} = await lines[Symbol.asyncIterator]().next();
    if (!folder) throw new Error("Creator did not mark scratch");
    const file = join(folder, "frame-001.png");
    await writeFile(file, "working");
    const rows = await inspectScratch(scan, true);
    expect(await readFile(file, "utf8")).toBe("working");
    expect(rows).toContainEqual(expect.objectContaining({path: folder, state: expect.stringMatching(/^live/), removed: false}));
  } finally {
    lines.close();
    child.kill();
    await exited;
  }
});

it("D03 keeps the external target of a matching link with a copied marker", async () => {
  const outside = abandon('console.log(await createScratch("screenshots", process.argv[1]));', root);
  const marker = join(outside, markerName);
  await copyFile(marker, join(root, "marker-copy"));
  await copyFile(join(root, "marker-copy"), marker);
  const file = join(outside, "frame-001.png");
  await writeFile(file, "outside");
  await symlink(outside, join(scan, basename(outside)), "junction");
  await inspectScratch(scan, true);
  expect(await readFile(file, "utf8")).toBe("outside");
});

it("lists the three temp kinds by default and the two adjacent kinds only in the selected directory", async () => {
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, root);
  try {
    const lock = join(scan, ".example.mp4.fom-lock");
    const [analyze, calibrate, transcribe, shots] = JSON.parse(abandon(`
      const dirs = await Promise.all(["analyze", "calibration", "transcribe"].map(kind => createScratch(kind)));
      dirs.push(await createScratch("screenshots", process.argv[1]));
      await createMediaLock(process.argv[2]);
      console.log(JSON.stringify(dirs));
    `, scan, lock)) as string[];
    const temp = await inspectScratch();
    expect(temp.map(row => [row.kind, row.path]).sort()).toEqual([
      ["analyze", analyze], ["calibration", calibrate], ["transcribe", transcribe],
    ]);
    const local = await inspectScratch(scan);
    expect(local.map(row => [row.kind, row.path]).sort()).toEqual([["media-lock", lock], ["screenshots", shots]]);
    for (const row of [...temp, ...local]) {
      expect(row).toMatchObject({state: "abandoned", removed: false});
      expect(row.size).toBeGreaterThan(0);
      expect(row.ageMs).toBeGreaterThanOrEqual(0);
      expect(await readFile(join(row.path, markerName), "utf8")).toBeTruthy();
    }
    const removed = [...await inspectScratch(undefined, true), ...await inspectScratch(scan, true)];
    expect(removed.filter(row => row.removed).map(row => row.path).sort()).toEqual([...temp, ...local].map(row => row.path).sort());
  } finally { vi.unstubAllEnvs(); }
});
