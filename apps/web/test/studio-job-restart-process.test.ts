import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  LocalSqliteJobRepository,
} from "../server-local/studio-jobs/sqlite-job-repository";
import {
  RESTART_FIXTURE_IDS,
} from "./fixtures/studio-job-restart-child";

interface ChildResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const recoveryChildReportSchema = z.object({
  interruptedJobIds: z.array(z.string()),
  retryKind: z.literal("created"),
  retryJobId: z.string(),
}).strict();

describe("Local Studio process restart recovery", () => {
  test("interrupts abandoned attempts and requires an explicit linked retry", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "frame-of-mind-restart-test-"),
    );
    const databasePath = join(temporaryRoot, "studio.sqlite");
    try {
      const seeded = await runChild("seed", databasePath);
      expect(seeded.exitCode).toBe(73);
      expect(seeded.stderr).toBe("");

      const recovered = await runChild("recover", databasePath);
      expect(recovered.exitCode).toBe(0);
      expect(recovered.stderr).toBe("");
      const report = recoveryChildReportSchema.parse(
        JSON.parse(recovered.stdout),
      );
      expect(report).toEqual({
        interruptedJobIds: [
          RESTART_FIXTURE_IDS.running,
          RESTART_FIXTURE_IDS.canceling,
        ],
        retryKind: "created",
        retryJobId: RESTART_FIXTURE_IDS.retry,
      });

      const database = new Database(databasePath);
      try {
        const repository = new LocalSqliteJobRepository(database);
        const running = await repository.get(RESTART_FIXTURE_IDS.running);
        const canceling = await repository.get(RESTART_FIXTURE_IDS.canceling);
        const queued = await repository.get(RESTART_FIXTURE_IDS.queued);
        const succeeded = await repository.get(RESTART_FIXTURE_IDS.succeeded);
        const failed = await repository.get(RESTART_FIXTURE_IDS.failed);
        const retry = await repository.get(RESTART_FIXTURE_IDS.retry);

        expect(running).toMatchObject({
          stage: "interrupted",
          terminal: { code: "executor_restart" },
        });
        expect(canceling).toMatchObject({
          stage: "interrupted",
          cancellationRequestedAt: expect.any(String),
          terminal: { code: "executor_restart" },
        });
        expect(queued).toMatchObject({
          stage: "succeeded",
          attempt: 1,
          runId: `run_${RESTART_FIXTURE_IDS.queued}`,
        });
        expect(succeeded).toMatchObject({
          stage: "succeeded",
          runId: "run_restart_fixture_existing",
        });
        expect(failed).toMatchObject({
          stage: "failed",
          terminal: { code: "synthetic_failure" },
        });
        expect(retry).toMatchObject({
          stage: "succeeded",
          attempt: 2,
          retryOfJobId: RESTART_FIXTURE_IDS.running,
          rootJobId: RESTART_FIXTURE_IDS.running,
          runId: `run_${RESTART_FIXTURE_IDS.retry}`,
        });
        expect(retry?.inputDigest).toBe(running?.inputDigest);
        expect(retry?.input).toEqual(running?.input);

        expect(await transitionStages(repository, RESTART_FIXTURE_IDS.running))
          .toEqual([
            "fetching_context",
            "uploading_to_gemini",
            "interrupted",
          ]);
        expect(await transitionStages(repository, RESTART_FIXTURE_IDS.canceling))
          .toEqual([
            "fetching_context",
            "uploading_to_gemini",
            "indexing",
            "interrupted",
          ]);
        expect(await eventKinds(repository, RESTART_FIXTURE_IDS.canceling))
          .toEqual([
            "transition",
            "transition",
            "transition",
            "cancellation_requested",
            "transition",
          ]);
        expect(await transitionStages(repository, RESTART_FIXTURE_IDS.queued))
          .toEqual(["fetching_context", "cleaning_up", "succeeded"]);
        expect(await transitionStages(repository, RESTART_FIXTURE_IDS.succeeded))
          .toEqual(["fetching_context", "cleaning_up", "succeeded"]);
        expect(await transitionStages(repository, RESTART_FIXTURE_IDS.failed))
          .toEqual(["fetching_context", "cleaning_up", "failed"]);
        expect(await transitionStages(repository, RESTART_FIXTURE_IDS.retry))
          .toEqual(["fetching_context", "cleaning_up", "succeeded"]);

        const allJobs = await repository.list({
          limit: 100,
          order: "oldest",
        });
        expect(allJobs.jobs).toHaveLength(6);
      } finally {
        database.close();
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);
});

async function runChild(
  mode: "seed" | "recover",
  databasePath: string,
): Promise<ChildResult> {
  const fixturePath = join(
    import.meta.dir,
    "fixtures",
    "studio-job-restart-child.ts",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fixturePath,
      mode,
      databasePath,
    ],
    {
      cwd: process.cwd(),
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    return {
      exitCode,
      stderr: stderr.trim(),
      stdout: stdout.trim(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function transitionStages(
  repository: LocalSqliteJobRepository,
  jobId: string,
): Promise<string[]> {
  return (await repository.events(jobId))
    .filter((event) => event.kind === "transition")
    .map((event) => event.stage);
}

async function eventKinds(
  repository: LocalSqliteJobRepository,
  jobId: string,
): Promise<string[]> {
  return (await repository.events(jobId)).map((event) => event.kind);
}
