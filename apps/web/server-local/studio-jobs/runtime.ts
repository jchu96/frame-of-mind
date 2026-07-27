import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  AnalysisJobExecutor,
  RuntimeSecretResolver,
} from "../../../../src/domain/studio-ports.js";
import {
  createDefaultAnalysisOrchestrator,
  type AnalysisProjectionPublisher,
} from "../../../../src/services/analyze.js";
import {
  clearLocalRunStore,
  configureLocalRunStore,
  createLocalRunStoreFromDatabase,
} from "../../server/data/sqlite.js";
import {
  storedOAuthPresent,
} from "../studio-configuration/connections.js";
import {
  getRuntimeSecretResolver,
} from "../studio-configuration/runtime-secrets.js";
import type {
  LocalMediaStagingAdapter,
} from "../studio-media/local-media-staging.js";
import {
  getLocalMediaStaging,
} from "../studio-media/service.js";
import {
  LocalStudioAnalyzeOptionsResolver,
} from "./analysis-options.js";
import {
  RepositoryStudioJobApi,
  type StudioJobApi,
} from "./api-service.js";
import {
  LocalStudioJobControl,
} from "./job-control.js";
import {
  LocalStudioJobWorker,
} from "./local-job-worker.js";
import {
  LocalInitialMediaGuard,
  LocalMediaReuseGuard,
} from "./media-reuse-guard.js";
import {
  OrchestratedAnalysisJobExecutor,
} from "./orchestrated-job-executor.js";
import {
  LocalSqliteJobRepository,
} from "./sqlite-job-repository.js";

export interface LocalStudioJobRuntime {
  api: StudioJobApi;
  worker: LocalStudioJobWorker;
  shutdown(): Promise<void>;
}

export interface LocalStudioJobRuntimeOptions {
  database: Database;
  media: LocalMediaStagingAdapter;
  secrets: RuntimeSecretResolver;
  oauthCredentialPresent(provider: "bluedot" | "granola"): boolean;
  executor?: AnalysisJobExecutor;
  projection?: AnalysisProjectionPublisher;
  outputRoot?: string;
  onShutdown?: () => Promise<void> | void;
}

export async function createLocalStudioJobRuntime(
  options: LocalStudioJobRuntimeOptions,
): Promise<LocalStudioJobRuntime> {
  const repository = new LocalSqliteJobRepository(options.database);
  const initialMedia = new LocalInitialMediaGuard(options.media);
  const mediaReuse = new LocalMediaReuseGuard(options.media);
  const analyzeOptions = new LocalStudioAnalyzeOptionsResolver({
    media: options.media,
    secrets: options.secrets,
    oauthCredentialPresent: options.oauthCredentialPresent,
    ...(options.outputRoot ? { outputRoot: options.outputRoot } : {}),
  });
  const runStore = options.projection
    ? undefined
    : createLocalRunStoreFromDatabase(options.database);
  const projection = options.projection ?? {
    publish: async (run) => {
      await runStore!.importRun(run);
    },
  };
  const executor = options.executor ?? new OrchestratedAnalysisJobExecutor({
    orchestrator: createDefaultAnalysisOrchestrator(),
    resolveAnalyzeOptions: (job) => analyzeOptions.resolve(job),
    projection,
    initialMediaGuard: initialMedia,
    mediaReuseGuard: mediaReuse,
    onMediaLeaseReleaseError: (failure) => {
      console.error("Local Studio media lease release failed.", {
        code: failure.code,
      });
    },
  });
  const worker = new LocalStudioJobWorker(repository, executor, {
    onWorkerError: (failure) => {
      console.error("Local Studio job worker failed.", {
        code: failure.code,
        ...(failure.jobId ? { jobId: failure.jobId } : {}),
      });
    },
  });
  const control = new LocalStudioJobControl(
    repository,
    worker,
    mediaReuse,
    {
      validateRetryInput: (input) => analyzeOptions.assertReady(input),
    },
  );
  const api = new RepositoryStudioJobApi(
    repository,
    control,
    worker,
    {
      validateInitialInput: async (input, checkedAt) => {
        await initialMedia.assertUsable(input, checkedAt);
        await analyzeOptions.assertReady(input);
      },
    },
  );
  await worker.start();
  let stopped = false;
  return {
    api,
    worker,
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      await worker.shutdown();
      await options.onShutdown?.();
    },
  };
}

let configuredRuntime: Promise<LocalStudioJobRuntime> | undefined;

export function getLocalStudioJobRuntime():
  Promise<LocalStudioJobRuntime> {
  configuredRuntime ??= startProductionRuntime().catch((error) => {
    configuredRuntime = undefined;
    throw error;
  });
  return configuredRuntime;
}

async function startProductionRuntime(): Promise<LocalStudioJobRuntime> {
  const path = resolve(
    process.env.NUXT_SQLITE_PATH || ".data/frame-of-mind.sqlite",
  );
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true });
  let runtime: LocalStudioJobRuntime | undefined;
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600);
    const runStore = createLocalRunStoreFromDatabase(database);
    runtime = await createLocalStudioJobRuntime({
      database,
      media: await getLocalMediaStaging(),
      secrets: getRuntimeSecretResolver(),
      oauthCredentialPresent: storedOAuthPresent,
      projection: {
        publish: async (run) => {
          await runStore.importRun(run);
        },
      },
      onShutdown: () => {
        clearLocalRunStore(path, runStore);
        database.close();
        configuredRuntime = undefined;
      },
    });
    configureLocalRunStore(path, runStore);
    return runtime;
  } catch (error) {
    if (runtime) {
      await runtime.shutdown();
    } else {
      database.close();
    }
    throw error;
  }
}

export function resetLocalStudioJobRuntimeForTests(): void {
  configuredRuntime = undefined;
}
