import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { expect, it } from "vitest";
import { validateCliDocument } from "./helpers/cli-schema.js";

it("start closes stdout at admission and a fresh process settles a killed worker from disk", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cli-job-kill-")));
  const media = join(root, "media"), out = join(root, "out");
  const log = join(root, "requests");
  const entry = resolve("src/cli.ts");
  const preload = resolve("test/helpers/job-provider-preload.mjs");
  const args = ["--no-env-file", "--preload", preload, entry, "analyze"];
  const env = {PATH: process.env.PATH, HOME: root, SystemRoot: process.env.SystemRoot, GEMINI_API_KEY: "stand-in", JOB_FIXTURE_LOG: log};
  const folders = ["--json", "--out", out, "--media-root", media, "--output-root", out];
  const start = ["start", join(media, "tiny.mp4"), ...folders, "--recipe", "requirements", "--allowed-models", "gemini-test",
    "--retention", "run", "--request-id", randomUUID(), "--max-file-bytes", "65536", "--max-media-seconds", "2", "--max-provider-requests", "8"];
  function fresh(call: string[], status: number) {
    const result = spawnSync("bun", [...args, ...call], {env, encoding: "utf8"});
    expect(result.status, result.stderr).toBe(status);
    return JSON.parse(result.stdout);
  }
  try {
    await Promise.all([mkdir(media), mkdir(out)]);
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=16x16:r=1:d=1",
      "-frames:v", "1", "-c:v", "mpeg4", start[1]!], {env});
    const child = spawn("bun", [...args, ...start], {env, stdio: ["ignore", "pipe", "pipe"]});
    const stopped = once(child, "exit");
    let watchdogFired = false;
    const watchdog = setTimeout(() => { watchdogFired = true; child.kill("SIGKILL"); }, 4000);
    try {
      const pending = new Promise<void>((done, reject) => {
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk; if (stderr.includes("fixture generation pending")) done(); });
        child.once("exit", () => reject(new Error("Worker exited early: " + stderr)));
      });
      const [output] = await Promise.all([text(child.stdout), pending]);
      expect(watchdogFired, "EOF before worker termination").toBe(false);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      const job = validateCliDocument("job", output);
      expect(job.state).toBe("queued");
      child.kill("SIGKILL");
      await stopped;
      const lookup = [job.jobId, ...folders];
      const status = fresh(["status", ...lookup], 0);
      expect(status).toMatchObject({state: "outcome_unknown", stage: "index", receipt: {providerRequests: 3}});
      expect(fresh(["result", ...lookup], 3).error.details.jobId).toBe(job.jobId);
      expect(fresh(start, 0).jobId).toBe(job.jobId);
      expect(fresh(["cancel", ...lookup], 0).cancel.steps).toContain("worker already stopped");
      expect(await readFile(log, "utf8")).toBe("start\nfinalize\ngenerate\n");
      expect(await readdir(join(out, ".frameofmind-jobs", job.jobId))).not.toContain("scratch");
      expect(await readdir(media)).toEqual(["tiny.mp4"]);
    } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await stopped; }
  } finally { await rm(root, {recursive: true, force: true}); }
}, 30_000);
