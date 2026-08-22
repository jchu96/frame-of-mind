import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisJob, MediaSession } from "../../../src/domain/studio-schemas";
import type { RunStore } from "../server/data/types";
import {
  publishedRunDirectory,
  reimportPublishedJobRun,
  StudioRunReimportError,
} from "../server-local/studio-jobs/run-reimport";
import {
  retryFailedMediaCleanup,
  StudioMediaCleanupRetryError,
} from "../server-local/studio-media/cleanup-retry";
import { videoRunFixture } from "./fixtures";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function job(stage: AnalysisJob["stage"], runId?: string): AnalysisJob {
  const terminal = ["succeeded", "failed", "canceled", "interrupted"]
    .includes(stage);
  return {
    id: `job_reimport_${stage}_0001`,
    rootJobId: `job_reimport_${stage}_0001`,
    attempt: 1,
    idempotencyKey: `reimport-${stage}-0001`,
    inputDigest: "a".repeat(64),
    stage,
    input: {
      mediaSessionId: "media_reimport_0000001",
      mediaSha256: "a".repeat(64),
      context: { mode: "none" },
      recipe: {
        id: "issue-review",
        custom: false,
        revision: "test",
        sha256: "c".repeat(64),
      },
      model: "gemini-test",
      retention: {
        mode: "ephemeral",
        expiresAt: "2026-08-23T12:00:00.000Z",
      },
    },
    ...(terminal
      ? {
          terminal: {
            outcome: stage as "succeeded" | "failed" | "canceled" | "interrupted",
            at: "2026-08-22T12:00:00.000Z",
          },
        }
      : {}),
    ...(runId ? { runId } : {}),
    createdAt: "2026-08-22T11:00:00.000Z",
    updatedAt: "2026-08-22T12:00:00.000Z",
  };
}

function fakeStore(
  imported: string[],
): RunStore {
  return {
    async listRuns() {
      return { runs: [] };
    },
    async getRun() {
      return null;
    },
    async importRun(input) {
      imported.push(input.manifest.runId);
      return {
        runId: input.manifest.runId,
        created: imported.length === 1,
      };
    },
  };
}

describe("Studio job re-import route service", () => {
  test("rejects every nonsucceeded state without changing the job", async () => {
    for (const stage of [
      "queued",
      "fetching_context",
      "uploading_to_gemini",
      "indexing",
      "interrogating",
      "rendering",
      "cleaning_up",
      "failed",
      "canceled",
      "interrupted",
    ] as const) {
      const candidate = job(stage);
      const before = structuredClone(candidate);
      const error = await reimportPublishedJobRun({
        job: candidate,
        outputRoot: "/unused",
        store: fakeStore([]),
      }).catch((failure) => failure);
      expect(error).toBeInstanceOf(StudioRunReimportError);
      expect(error.code).toBe("job_not_succeeded");
      expect(candidate).toEqual(before);
    }
  });

  test("validates the existing run pair and imports it idempotently", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "fom-reimport-test-"));
    temporaryRoots.push(outputRoot);
    const fixture = await videoRunFixture();
    const succeeded = job("succeeded", fixture.manifest.runId);
    const directory = publishedRunDirectory(succeeded, outputRoot);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "analysis.json"), JSON.stringify(fixture.analysis)),
      writeFile(join(directory, "manifest.json"), JSON.stringify(fixture.manifest)),
    ]);
    const imported: string[] = [];
    const store = fakeStore(imported);

    expect(await reimportPublishedJobRun({ job: succeeded, outputRoot, store }))
      .toEqual({ runId: fixture.manifest.runId, created: true });
    expect(await reimportPublishedJobRun({ job: succeeded, outputRoot, store }))
      .toEqual({ runId: fixture.manifest.runId, created: false });
    expect(imported).toEqual([
      fixture.manifest.runId,
      fixture.manifest.runId,
    ]);
  });

  test("returns fixed conflict codes for missing, invalid, or mismatched result files", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "fom-reimport-errors-"));
    temporaryRoots.push(outputRoot);
    const fixture = await videoRunFixture();
    const succeeded = job("succeeded", fixture.manifest.runId);
    let error = await reimportPublishedJobRun({
      job: succeeded,
      outputRoot,
      store: fakeStore([]),
    }).catch((failure) => failure);
    expect(error.code).toBe("run_bundle_not_found");

    const directory = publishedRunDirectory(succeeded, outputRoot);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "analysis.json"), "{}"),
      writeFile(join(directory, "manifest.json"), "{}"),
    ]);
    error = await reimportPublishedJobRun({
      job: succeeded,
      outputRoot,
      store: fakeStore([]),
    }).catch((failure) => failure);
    expect(error.code).toBe("run_bundle_invalid");

    const otherJob = job("succeeded", "run_other_000000001");
    const otherDirectory = publishedRunDirectory(otherJob, outputRoot);
    await mkdir(otherDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(otherDirectory, "analysis.json"), JSON.stringify(fixture.analysis)),
      writeFile(join(otherDirectory, "manifest.json"), JSON.stringify(fixture.manifest)),
    ]);
    error = await reimportPublishedJobRun({
      job: otherJob,
      outputRoot,
      store: fakeStore([]),
    }).catch((failure) => failure);
    expect(error.code).toBe("run_bundle_job_mismatch");
  });
});

describe("Studio cleanup retry route service", () => {
  const receipt = {
    id: "media_cleanup_retry_0001",
    status: "cleanup_failed",
  } as MediaSession;

  test("rejects missing media and every state except cleanup_failed", async () => {
    let error = await retryFailedMediaCleanup({
      get: async () => undefined,
      delete: async () => receipt,
    }, receipt.id).catch((failure) => failure);
    expect(error).toBeInstanceOf(StudioMediaCleanupRetryError);
    expect(error.code).toBe("media_not_found");

    for (const status of [
      "created",
      "uploading",
      "sealed",
      "in_use",
      "retained",
      "expired",
      "aborted",
      "deleting",
      "deleted",
      "failed",
    ] as const) {
      let deleted = false;
      error = await retryFailedMediaCleanup({
        get: async () => ({ ...receipt, status }),
        delete: async () => {
          deleted = true;
          return receipt;
        },
      }, receipt.id).catch((failure) => failure);
      expect(error.code).toBe("media_cleanup_not_retryable");
      expect(deleted).toBe(false);
    }
  });

  test("returns only the adapter's resulting status and propagates another cleanup failure", async () => {
    const deleted = { ...receipt, status: "deleted" as const };
    expect(await retryFailedMediaCleanup({
      get: async () => receipt,
      delete: async () => deleted,
    }, receipt.id)).toBe(deleted);

    const failure = new Error("synthetic cleanup failure");
    expect(await retryFailedMediaCleanup({
      get: async () => receipt,
      delete: async () => { throw failure; },
    }, receipt.id).catch((error) => error)).toBe(failure);
  });
});
