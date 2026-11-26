import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { program } from "../src/cli-main.js";
import { childEnvironment } from "../src/lib/child-env.js";

let root: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "doctor-encode-")));
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=96x64:r=25:d=20",
    "-threads", "1", "-c:v", "mpeg4", join(root, "source.mp4")], {env: childEnvironment("media")});
  await writeFile(join(root, "output.mp4"), "original destination");
  await writeFile(join(root, "other"), "operator file");
});
afterAll(async () => { if (root) await rm(root, {recursive: true, force: true}); });

it("lists and reclaims a SIGKILLed proxy encode and preserves every sibling byte", async () => {
  const files = (await readdir(root)).sort();
  const bytes = () => Promise.all(files.map(name => readFile(join(root, name))));
  const original = await bytes();
  const lock = join(root, ".output.mp4.fom-lock");
  const child = spawn("bun", ["--no-env-file", resolve("src/cli.ts"), "proxy", "source.mp4", "-o", "output.mp4", "--force"],
    {cwd: root, env: childEnvironment("media"), detached: true, stdio: "ignore"});
  const exited = once(child, "exit");
  function killRun() {
    if (process.platform === "win32") execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
    else process.kill(-child.pid!, "SIGKILL");
  }
  try {
    // stageOutput initially opens an empty file. Only ffmpeg writes its MP4 header.
    const deadline = performance.now() + 4000;
    for (;;) {
      const stage = (await readdir(lock).catch(() => [] as string[])).find(name => name.startsWith("stage-"));
      if (stage && (await stat(join(lock, stage, "output.mp4")).catch(() => undefined))?.size) break;
      if (child.exitCode !== null || child.signalCode || performance.now() >= deadline) throw new Error("Did not observe an active encode");
      await delay(5);
    }
    const start = performance.now();
    killRun();
    await exited;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(["doctor", "--scratch", root], {from: "user"});
      expect(stdout.mock.calls.flat().join("")).toMatch(/listed media-lock .*\d+ bytes, age \d+ ms, proven, abandoned/);
      expect(stdout.mock.calls.flat().join("")).toContain(JSON.stringify(lock));
      expect((await stat(lock)).isDirectory()).toBe(true);
      await program.parseAsync(["doctor", "--scratch", root, "--remove", lock], {from: "user"});
      expect(stdout.mock.calls.flat().join("")).toContain("removed media-lock");
    } finally { stdout.mockRestore(); }
    expect((await readdir(root)).sort()).toEqual(files);
    expect(await bytes()).toEqual(original);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1250);
    console.info(`Killed proxy listed and removed in ${Math.ceil(elapsed)} ms; ${files.length} sibling files byte-identical.`);
  } finally {
    if (child.exitCode === null && !child.signalCode) { killRun(); await exited; }
  }
}, 30_000);
