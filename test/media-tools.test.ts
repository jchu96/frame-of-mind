import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runMediaTool, stageOutput } from "../src/services/media-tools.js";

let root: string, input: string, output: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fom-media-tools-"));
  input = join(root, "original.mp4"); output = join(root, "prepared.mp4");
  await writeFile(input, "synthetic recording");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, {recursive: true, force: true}); });
const digest = async () => createHash("sha256").update(await readFile(input)).digest("hex");
it("F02 preserves original bytes after cancellation following an encoded frame", async () => {
  const before = await digest();
  const controller = new AbortController();
  await expect(stageOutput(input, output, [".mp4"], false, controller.signal, async staged => {
    await runMediaTool("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=s=32x32:r=25", "-frames:v", "1", "-c:v", "libx264", staged]);
    expect((await stat(staged)).size).toBeGreaterThan(0);
    controller.abort();
  })).rejects.toThrow();
  expect(await digest().catch(() => "original missing"), "original exists and hash matches").toBe(before);
  expect(await readdir(root)).toEqual(["original.mp4"]);
});
it("F03 rejects error stderr even with a plausible staged file and a zero exit", async () => {
  await expect(stageOutput(input, output, [".mp4"], false, undefined, async staged => {
    await runMediaTool("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=s=32x32:r=25", "-frames:v", "1", staged]);
    await runMediaTool(process.execPath, ["-e", "process.stderr.write('synthetic decode error')"]);
  }), "error-level stderr must fail publication").rejects.toThrow();
  expect(await readdir(root)).toEqual(["original.mp4"]);
});
it.each(["missing", "timeout", "abort"])("cleans staging and retains prior output on %s", async kind => {
  await writeFile(output, "prior output");
  const controller = new AbortController();
  await expect(stageOutput(input, output, [".mp4"], true, controller.signal, async staged => {
    await writeFile(staged, "partial");
    const timer = kind === "abort" ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      await runMediaTool(kind === "missing" ? join(root, "absent") : process.execPath, ["-e", "setInterval(()=>{},1000)"],
        { signal: controller.signal, timeoutMs: kind === "timeout" ? 100 : 2000 });
    } finally { clearTimeout(timer); }
  })).rejects.toThrow();
  expect(await readFile(output, "utf8")).toBe("prior output");
  expect((await readdir(root)).sort()).toEqual(["original.mp4", "prepared.mp4"]);
});
it("real child sees only the allowed environment", async () => {
  vi.stubEnv("FOM_UNLISTED_MARKER", "synthetic");
  expect(await runMediaTool(process.execPath, ["-p", "typeof process.env.FOM_UNLISTED_MARKER"])).toBe("undefined\n");
});
it("publishes exactly one competing no-force output", async () => {
  const results = await Promise.allSettled(["one", "two"].map(value =>
    stageOutput(input, output, [".mp4"], false, undefined, staged => writeFile(staged, value))));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(["one", "two"]).toContain(await readFile(output, "utf8"));
  expect((await readdir(root)).sort()).toEqual(["original.mp4", "prepared.mp4"]);
});

it("warns or refuses on prediction, checks actual bytes before publication, and permits equality and override", async () => {
  const {checkProxyBytes, estimateProxyBytes} = await import("../src/services/media-helpers.js");
  const lines: string[] = [];
  const tell = (line: string) => lines.push(line);
  expect(estimateProxyBytes(1280, 720, 25n, 1)).toBe(243168);
  checkProxyBytes(1_800_000_000, false, "estimate", tell);
  expect(lines).toHaveLength(1);
  checkProxyBytes(1_900_000_000, false, "estimate", tell);
  expect(lines.at(-1)).toContain("Warning");
  expect(() => checkProxyBytes(2_100_000_000, false, "estimate", tell)).toThrow("estimate exceeds");
  checkProxyBytes(2_100_000_000, true, "estimate", tell);
  checkProxyBytes(2_000_000_000, false, "actual", tell);
  checkProxyBytes(2_100_000_000, true, "actual", tell);
  await writeFile(output, "old");
  await expect(stageOutput(input, output, [".mp4"], true, undefined, async staged => {
    checkProxyBytes(42, false, "estimate", tell);
    const {truncate} = await import("node:fs/promises");
    await truncate(staged, 2_000_000_001);
    checkProxyBytes((await stat(staged)).size, false, "actual", tell);
  })).rejects.toThrow("actual exceeds");
  expect(await readFile(output, "utf8")).toBe("old");
});
it("refuses a destination replaced during encoding and preserves its new contents", async () => {
  await writeFile(output, "old");
  await expect(stageOutput(input, output, [".mp4"], true, undefined, async staged => {
    await writeFile(staged, "new");
    await rm(output);
    await writeFile(output, "external replacement");
  })).rejects.toThrow("Destination changed");
  expect(await readFile(output, "utf8")).toBe("external replacement");
});
it("refuses an input edited in place during staging", async () => {
  // Make the edit observable even on filesystems with coarse timestamps.
  await utimes(input, new Date(0), new Date(0));
  const before = await stat(input, {bigint: true});
  await expect(stageOutput(input, output, [".mp4"], false, undefined, async staged => {
    await writeFile(staged, "candidate");
    await writeFile(input, "Synthetic recording", {flag: "r+"});
    expect(await stat(input, {bigint: true})).toMatchObject({dev: before.dev, ino: before.ino, size: before.size});
  }), "same-inode edit must stop publication").rejects.toThrow("Input recording changed");
  expect(await readFile(input, "utf8")).toBe("Synthetic recording");
  expect(await readdir(root)).toEqual(["original.mp4"]);
});

it("explains an existing destination lock and leaves it in place", async () => {
  const lock = join(root, ".prepared.mp4.fom-lock");
  await mkdir(lock);
  await expect(stageOutput(input, output, [".mp4"], false, undefined, staged => writeFile(staged, "candidate")))
    .rejects.toThrow(/\.prepared\.mp4\.fom-lock.*interrupted run.*safe to remove.*no other frameofmind command is writing to this destination/i);
  expect((await readdir(root)).sort()).toEqual([".prepared.mp4.fom-lock", "original.mp4"]);
});
it("never replaces an outside publisher that wins creation of an absent target", async () => {
  await expect(stageOutput(input, output, [".mp4"], true, undefined, async staged => {
    await writeFile(staged, "candidate");
    await writeFile(output, "winner", {flag: "wx"});
  })).rejects.toThrow("Destination changed");
  expect(await readFile(output, "utf8")).toBe("winner");
});

it("refuses a dangling link, a directory, and a destination with the wrong extension", async () => {
  const {mkdir, symlink} = await import("node:fs/promises");
  const dangling = join(root, "dangling.mp4"), directory = join(root, "folder.mp4");
  await symlink(join(root, "missing.mp4"), dangling);
  await mkdir(directory);
  for (const destination of [dangling, directory, join(root, "wrong.mov")]) {
    await expect(stageOutput(input, destination, [".mp4"], true, undefined, () => Promise.reject(new Error("unexpected encoder"))))
      .rejects.toThrow(/Destination/);
  }
  expect((await readdir(root)).sort()).toEqual(["dangling.mp4", "folder.mp4", "original.mp4"]);
});
