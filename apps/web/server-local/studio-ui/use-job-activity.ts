import { analysisJobEventSchema, analysisJobSchema } from "../../../../src/domain/studio-schemas";
import type { JobListPage } from "../../../../src/domain/studio-ports";
import { z } from "zod";
import { onMounted, onUnmounted, ref, shallowRef } from "vue";

const jobListPageSchema = z.object({
  jobs: z.array(analysisJobSchema),
  nextCursor: z.string().optional(),
}).strict();

const [
  transitionEventSchema,
  progressEventSchema,
  cancellationRequestedEventSchema,
  warningEventSchema,
  cleanupEventSchema,
] = analysisJobEventSchema.options;
const activityJobEventSchema = z.discriminatedUnion("kind", [
  transitionEventSchema.strip(),
  progressEventSchema.strip(),
  cancellationRequestedEventSchema.strip(),
  warningEventSchema.strip(),
  cleanupEventSchema.strip(),
]);

const jobDetailSchema = z.object({
  job: analysisJobSchema,
  events: z.array(activityJobEventSchema),
  nextAfterSequence: z.number().int().nonnegative().optional(),
}).strict();

const MAX_JOB_DETAIL_PAGES = 20;

export type StudioJobDetail = z.infer<typeof jobDetailSchema>;

export interface JobActivityTransport {
  list(): Promise<JobListPage>;
  detail(jobId: string): Promise<StudioJobDetail>;
}

export interface JobActivityPollRuntime {
  hidden(): boolean;
  schedule(callback: () => void | Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
  listenVisibility(callback: () => void): () => void;
}

export interface JobActivityPollerOptions<T> {
  load(): Promise<T>;
  terminal(value: T): boolean;
  onData(value: T): void;
  onNotice(message: string | undefined): void;
  onLoading?(loading: boolean): void;
  runtime?: JobActivityPollRuntime;
  intervalMs?: number;
  maximumBackoffMs?: number;
}

export function activityListTerminal(_page: JobListPage): boolean {
  return false;
}

export function createJobActivityTransport(
  fetchImplementation: typeof fetch = fetch,
): JobActivityTransport {
  async function read(path: string): Promise<unknown> {
    const response = await fetchImplementation(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("Job activity request failed.");
    return response.json();
  }
  return {
    async list() {
      return jobListPageSchema.parse(
        await read("/api/studio/jobs?limit=100&order=newest"),
      );
    },
    async detail(jobId) {
      const basePath = `/api/studio/jobs/${encodeURIComponent(jobId)}?limit=100`;
      const events: StudioJobDetail["events"] = [];
      let afterSequence: number | undefined;

      for (let pageNumber = 0; pageNumber < MAX_JOB_DETAIL_PAGES; pageNumber += 1) {
        const page = jobDetailSchema.parse(
          await read(
            afterSequence === undefined
              ? basePath
              : `${basePath}&after=${afterSequence}`,
          ),
        );
        events.push(...page.events);
        if (page.nextAfterSequence === undefined) {
          return { ...page, events };
        }
        if (
          afterSequence !== undefined
          && page.nextAfterSequence <= afterSequence
        ) {
          throw new Error("Job activity pagination did not advance.");
        }
        afterSequence = page.nextAfterSequence;
      }

      throw new Error("Job activity exceeded the safe pagination limit.");
    },
  };
}

export function createJobActivityPoller<T>(
  options: JobActivityPollerOptions<T>,
) {
  const runtime = options.runtime ?? browserPollRuntime();
  const intervalMs = options.intervalMs ?? 3_000;
  const maximumBackoffMs = options.maximumBackoffMs ?? 30_000;
  let active = false;
  let polling = false;
  let failures = 0;
  let timer: unknown;
  let removeVisibilityListener: (() => void) | undefined;
  let running: Promise<void> | undefined;

  function clearTimer(): void {
    if (timer === undefined) return;
    runtime.cancel(timer);
    timer = undefined;
  }

  function schedule(delayMs: number): void {
    clearTimer();
    if (!active || !polling || runtime.hidden()) return;
    timer = runtime.schedule(async () => {
      timer = undefined;
      await run(false);
    }, delayMs);
  }

  async function run(manual: boolean): Promise<void> {
    if (!active || running || (!manual && runtime.hidden())) return running;
    options.onLoading?.(true);
    running = (async () => {
      try {
        const value = await options.load();
        failures = 0;
        options.onData(value);
        options.onNotice(undefined);
        if (options.terminal(value)) {
          polling = false;
          clearTimer();
        } else {
          polling = true;
          schedule(intervalMs);
        }
      } catch {
        failures += 1;
        options.onNotice(
          "Activity could not refresh. Showing the last update.",
        );
        schedule(Math.min(intervalMs * 2 ** failures, maximumBackoffMs));
      } finally {
        running = undefined;
        options.onLoading?.(false);
      }
    })();
    return running;
  }

  function visibilityChanged(): void {
    if (runtime.hidden()) {
      clearTimer();
      return;
    }
    if (active && polling) void run(false);
  }

  async function start(): Promise<void> {
    if (active) return running;
    active = true;
    polling = true;
    removeVisibilityListener = runtime.listenVisibility(visibilityChanged);
    return run(false);
  }

  function stop(): void {
    active = false;
    polling = false;
    clearTimer();
    removeVisibilityListener?.();
    removeVisibilityListener = undefined;
  }

  return {
    refresh: () => run(true),
    start,
    stop,
  };
}

export function useJobActivity<T>(options: {
  initial: T;
  load(): Promise<T>;
  terminal(value: T): boolean;
}) {
  const data = shallowRef<T>(options.initial);
  const notice = ref<string>();
  const loading = ref(true);
  const refreshing = ref(false);
  let loaded = false;
  const poller = createJobActivityPoller({
    load: options.load,
    terminal: options.terminal,
    onData(value) {
      data.value = value;
      loaded = true;
    },
    onNotice(message) {
      notice.value = message;
    },
    onLoading(value) {
      refreshing.value = value;
      loading.value = value && !loaded;
    },
  });

  onMounted(() => {
    void poller.start();
  });
  onUnmounted(() => poller.stop());

  return {
    data,
    loading,
    notice,
    refreshing,
    refresh: poller.refresh,
  };
}

function browserPollRuntime(): JobActivityPollRuntime {
  return {
    hidden: () => typeof document !== "undefined" && document.hidden,
    schedule(callback, delayMs) {
      return setTimeout(() => void callback(), delayMs);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    listenVisibility(callback) {
      if (typeof document === "undefined") return () => undefined;
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
  };
}
