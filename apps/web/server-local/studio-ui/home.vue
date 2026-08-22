<script setup lang="ts">
import type {
  AnalysisJob,
  ConfigurationStatus,
} from "../../../../src/domain/studio-schemas";
import type { JobListPage } from "../../../../src/domain/studio-ports";
import type { RunPage, RunSummary } from "../../shared/types";
import { loadIntentDraft } from "./intent-composer";
import { intentReceiptStatus } from "./run-composer";
import { useComposerReadiness } from "./use-composer-readiness";

useSeoMeta({
  title: "Studio Home · Frame of Mind",
  description: "Start and monitor private local video-understanding work.",
});

type ProviderStatus = ConfigurationStatus["providers"][number];
type StatusColor = "primary" | "success" | "warning" | "error" | "neutral";

const {
  primaryAction,
  readiness,
  refresh: refreshReadiness,
} = useComposerReadiness();

const terminalStages = new Set([
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
]);
const providerDetails = {
  gemini: {
    label: "Gemini",
    purpose: "Video understanding",
    icon: "i-lucide-sparkles",
  },
  bluedot: {
    label: "Bluedot",
    purpose: "Meeting context",
    icon: "i-lucide-video",
  },
  granola: {
    label: "Granola",
    purpose: "Meeting context",
    icon: "i-lucide-notebook-tabs",
  },
} as const;

const {
  data: jobPage,
  error: jobsError,
  refresh: refreshJobs,
  status: jobsStatus,
} = await useFetch<JobListPage>("/api/studio/jobs", {
  query: { limit: 50 },
  server: false,
  default: () => ({ jobs: [] }),
});
const {
  data: runPage,
  error: runsError,
  refresh: refreshRuns,
  status: runsStatus,
} = await useFetch<RunPage>("/api/runs", {
  query: { limit: 5 },
  server: false,
  default: () => ({ runs: [] }),
});
const {
  data: configuration,
  error: configurationError,
  refresh: refreshConfiguration,
  status: configurationStatus,
} = await useFetch<ConfigurationStatus>("/api/studio/configuration", {
  server: false,
});
const {
  data: recipeCatalog,
  error: recipeCatalogError,
} = await useFetch<{
  recipes: Array<{ id: string; label: string; revision: string }>;
}>("/api/studio/recipes", { server: false });
const route = useRoute();
const createdJobId = computed(() =>
  typeof route.query.created === "string" ? route.query.created : undefined
);
const intentStatus = ref({
  ready: false,
  label: "Intent is missing. Choose and save a built-in recipe.",
});

const activeJobs = computed(() =>
  jobPage.value.jobs.filter((job) => !terminalStages.has(job.stage))
);
const recentRuns = computed(() => runPage.value.runs);
const providers = computed(() => configuration.value?.providers ?? []);
const connectedProviders = computed(() =>
  providers.value.filter((provider) => provider.connected).length
);
const initialLoading = computed(() =>
  [jobsStatus.value, runsStatus.value, configurationStatus.value]
    .some((value) => value === "idle" || value === "pending")
);
const refreshing = ref(false);
const hasLoadError = computed(() =>
  Boolean(jobsError.value || runsError.value || configurationError.value)
);

async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await Promise.all([
      refreshJobs(),
      refreshRuns(),
      refreshConfiguration(),
      refreshReadiness(),
    ]);
    if (typeof sessionStorage !== "undefined") {
      intentStatus.value = intentReceiptStatus(
        loadIntentDraft(sessionStorage),
        recipeCatalogError.value ? undefined : recipeCatalog.value?.recipes,
      );
    }
  } finally {
    refreshing.value = false;
  }
}

onMounted(() => {
  void refreshAll();
});

watch([recipeCatalog, recipeCatalogError], () => {
  if (typeof sessionStorage === "undefined") return;
  intentStatus.value = intentReceiptStatus(
    loadIntentDraft(sessionStorage),
    recipeCatalogError.value ? undefined : recipeCatalog.value?.recipes,
  );
});

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function stageLabel(job: AnalysisJob): string {
  if (job.cancellationRequestedAt) return "Canceling";
  return job.stage.replaceAll("_", " ");
}

function jobColor(job: AnalysisJob): StatusColor {
  if (job.cancellationRequestedAt) return "warning";
  return job.stage === "queued" ? "neutral" : "primary";
}

function providerColor(provider: ProviderStatus): StatusColor {
  if (provider.failureCode) return "warning";
  return provider.connected ? "success" : "neutral";
}

function providerStatusLabel(provider: ProviderStatus): string {
  if (provider.failureCode) return "Needs attention";
  return provider.connected ? "Connected" : "Not configured";
}

function intentReadinessLabel(): string {
  return intentStatus.value.label
    === "Intent is missing. Choose and save a built-in recipe."
    ? "Choose a recipe"
    : intentStatus.value.label;
}

function contextReadinessLabel(): string {
  return readiness.value.context === "none"
    ? "Optional"
    : readiness.value.context.replace("-", " ");
}

function recordingReadinessLabel(): string {
  return readiness.value.recording === "empty"
    ? "Add a recording"
    : readiness.value.recording;
}

function runTitle(run: RunSummary): string {
  return run.schemaVersion === 2
    ? run.meetingTitle || run.meetingId
    : "Video analysis";
}

function runContext(run: RunSummary): string {
  return run.schemaVersion === 2
    ? `${run.provider} via ${run.transport}`
    : "video only";
}

function jobContext(job: AnalysisJob): string {
  return "provider" in job.input.context
    ? `${job.input.context.provider} context`
    : "video only";
}
</script>

<template>
  <main
    class="fom-shell py-8 sm:py-10"
    data-studio-home="local"
  >
    <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div>
        <p class="fom-kicker text-primary">Runs on this machine</p>
        <h1 class="mt-3 max-w-3xl text-4xl font-black tracking-[-0.045em] sm:text-5xl">
          Turn a recording into findings.
        </h1>
        <p class="mt-4 max-w-2xl text-base leading-7 text-muted">
          Drop in a meeting recording, pick what you want to learn, and get
          timestamped findings you can act on. Nothing leaves this machine
          except the recording you send to Gemini.
        </p>
      </div>
      <UButton
        id="new-analysis"
        :to="primaryAction.to"
        icon="i-lucide-plus"
        :label="primaryAction.label"
        size="xl"
        class="justify-center"
      />
    </section>

    <UAlert
      v-if="createdJobId"
      class="mt-6"
      color="success"
      variant="soft"
      icon="i-lucide-check-circle"
      title="Analysis job started"
      :description="`Job ${createdJobId} is in the durable local queue.`"
      :actions="[{ label: 'Open job activity', to: `/activity/${encodeURIComponent(createdJobId)}` }]"
    />

    <section
      class="mt-8"
      aria-labelledby="composer-readiness-heading"
    >
      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p class="fom-kicker text-muted">New analysis</p>
              <h2 id="composer-readiness-heading" class="mt-2 text-2xl font-black">
                Three steps, any order
              </h2>
            </div>
            <UBadge :color="readiness.canRun ? 'success' : 'neutral'" variant="soft">
              {{ readiness.canRun ? "Ready for run receipt" : "Not ready" }}
            </UBadge>
          </div>
        </template>
        <div class="grid gap-3 sm:grid-cols-3">
          <NuxtLink
            to="/intent"
            class="rounded-xl border border-default p-4 transition hover:bg-elevated"
          >
            <p class="text-xs font-bold uppercase tracking-wider text-muted">Required</p>
            <p class="mt-2 font-black text-highlighted">Intent</p>
            <p
              class="mt-1 text-sm"
              :class="intentStatus.ready ? 'text-muted' : 'text-error'"
            >
              {{ intentReadinessLabel() }}
            </p>
          </NuxtLink>
          <NuxtLink
            to="/context"
            class="rounded-xl border border-default p-4 transition hover:bg-elevated"
          >
            <p class="text-xs font-bold uppercase tracking-wider text-muted">Optional</p>
            <p class="mt-2 font-black text-highlighted">Context</p>
            <p class="mt-1 text-sm capitalize text-muted">{{ contextReadinessLabel() }}</p>
          </NuxtLink>
          <NuxtLink
            to="/recording"
            class="rounded-xl border border-default p-4 transition hover:bg-elevated"
          >
            <p class="text-xs font-bold uppercase tracking-wider text-muted">Required</p>
            <p class="mt-2 font-black text-highlighted">Recording</p>
            <p class="mt-1 text-sm capitalize text-muted">{{ recordingReadinessLabel() }}</p>
          </NuxtLink>
        </div>
      </UCard>
    </section>

    <UAlert
      v-if="hasLoadError"
      class="mt-6"
      color="error"
      variant="soft"
      icon="i-lucide-triangle-alert"
      title="Some local status could not be loaded"
      description="Refresh this page. If the problem continues, restart Studio and use its new one-time launch URL."
    />

    <section
      class="mt-8 grid gap-4 sm:grid-cols-3"
      aria-label="Studio summary"
      aria-live="polite"
    >
      <NuxtLink to="/activity" aria-label="Open activity">
        <UCard data-testid="active-jobs-summary" class="h-full transition hover:bg-elevated">
          <p class="text-xs font-bold uppercase tracking-[0.16em] text-muted">Active jobs</p>
          <p class="mt-2 text-3xl font-black text-highlighted">
            {{ initialLoading ? "—" : activeJobs.length }}
          </p>
          <p class="mt-1 text-sm text-muted">Running now</p>
        </UCard>
      </NuxtLink>
      <UCard data-testid="recent-runs-summary">
        <p class="text-xs font-bold uppercase tracking-[0.16em] text-muted">Recent runs</p>
        <p class="mt-2 text-3xl font-black text-highlighted">
          {{ initialLoading ? "—" : recentRuns.length }}
        </p>
        <p class="mt-1 text-sm text-muted">Finished</p>
      </UCard>
      <UCard>
        <p class="text-xs font-bold uppercase tracking-[0.16em] text-muted">Connections</p>
        <p class="mt-2 text-3xl font-black text-highlighted">
          {{ initialLoading ? "—" : `${connectedProviders}/${providers.length || 3}` }}
        </p>
        <p class="mt-1 text-sm text-muted">Connected</p>
      </UCard>
    </section>

    <section
      v-if="!initialLoading && !hasLoadError && activeJobs.length === 0 && recentRuns.length === 0"
      class="mt-8"
      aria-labelledby="studio-empty-heading"
    >
      <UCard>
        <div class="grid gap-5 py-5 text-center sm:py-8">
          <UIcon
            name="i-lucide-clapperboard"
            class="mx-auto size-10 text-primary"
            aria-hidden="true"
          />
          <div>
            <p class="fom-kicker text-primary">Ready when you are</p>
            <h2 id="studio-empty-heading" class="mt-2 text-2xl font-black">
              No analyses yet
            </h2>
            <p class="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted">
              Use New analysis above to choose or drop a recording. Selecting
              a file stays on this machine; Gemini transfer happens only after
              a later explicit start receipt.
            </p>
          </div>
        </div>
      </UCard>
    </section>

    <section class="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.55fr)]">
      <UCard aria-labelledby="active-jobs-heading">
        <template #header>
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="fom-kicker text-muted">Local worker</p>
              <h2 id="active-jobs-heading" class="mt-2 text-2xl font-black">Active jobs</h2>
            </div>
            <UBadge color="neutral" variant="soft">
              One at a time
            </UBadge>
          </div>
        </template>

        <div
          v-if="jobsStatus === 'idle' || jobsStatus === 'pending'"
          class="flex items-center gap-3 py-6 text-sm text-muted"
        >
          <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
          Reading the durable local queue…
        </div>
        <UAlert
          v-else-if="jobsError"
          color="error"
          variant="soft"
          title="Job activity is unavailable"
          description="The local job runtime did not return status."
        />
        <div v-else-if="activeJobs.length" class="divide-y divide-default">
          <NuxtLink
            v-for="job in activeJobs"
            :key="job.id"
            :to="`/activity/${encodeURIComponent(job.id)}`"
            class="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            :aria-label="`${job.input.recipe.id}, ${stageLabel(job)}`"
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <p class="truncate font-bold text-highlighted">
                  {{ job.input.recipe.id }}
                </p>
                <UBadge :color="jobColor(job)" variant="soft" class="capitalize">
                  {{ stageLabel(job) }}
                </UBadge>
              </div>
              <p class="mt-1 truncate text-sm text-muted">
                {{ jobContext(job) }} · attempt {{ job.attempt }}
              </p>
            </div>
            <time :datetime="job.updatedAt" class="text-xs text-muted">
              Updated {{ formatDate(job.updatedAt) }}
            </time>
          </NuxtLink>
        </div>
        <div v-else class="py-6">
          <p class="font-semibold text-highlighted">Nothing is running.</p>
          <p class="mt-1 text-sm text-muted">
            New work will appear here after the composer submits it to the local queue.
          </p>
        </div>
      </UCard>

      <UCard aria-labelledby="connections-heading">
        <template #header>
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="fom-kicker text-muted">Private configuration</p>
              <h2 id="connections-heading" class="mt-2 text-2xl font-black">Connections</h2>
            </div>
            <UButton
              to="/connections"
              color="neutral"
              variant="ghost"
              icon="i-lucide-settings-2"
              aria-label="Manage connections"
            />
          </div>
        </template>

        <div
          v-if="configurationStatus === 'idle' || configurationStatus === 'pending'"
          class="flex items-center gap-3 py-6 text-sm text-muted"
        >
          <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
          Checking credential presence…
        </div>
        <UAlert
          v-else-if="configurationError"
          color="error"
          variant="soft"
          title="Connection health is unavailable"
        />
        <div v-else class="divide-y divide-default">
          <div
            v-for="provider in providers"
            :key="provider.provider"
            class="flex items-center gap-3 py-4 first:pt-0 last:pb-0"
            role="status"
          >
            <div class="grid size-9 shrink-0 place-items-center rounded-md bg-elevated">
              <UIcon
                :name="providerDetails[provider.provider].icon"
                class="size-5"
                aria-hidden="true"
              />
            </div>
            <div class="min-w-0 flex-1">
              <p class="font-bold text-highlighted">
                {{ providerDetails[provider.provider].label }}
              </p>
              <p class="truncate text-xs text-muted">
                {{ providerDetails[provider.provider].purpose }}
              </p>
            </div>
            <UBadge :color="providerColor(provider)" variant="soft">
              <span class="sr-only">{{ provider.provider }}: </span>
              {{ providerStatusLabel(provider) }}
            </UBadge>
          </div>
        </div>
      </UCard>
    </section>

    <section class="mt-8" aria-labelledby="recent-runs-heading">
      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p class="fom-kicker text-muted">Portable run projections</p>
              <h2 id="recent-runs-heading" class="mt-2 text-2xl font-black">Recent runs</h2>
            </div>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-refresh-cw"
              label="Refresh"
              :loading="refreshing"
              @click="refreshAll"
            />
          </div>
        </template>

        <div
          v-if="runsStatus === 'idle' || runsStatus === 'pending'"
          class="flex items-center gap-3 py-6 text-sm text-muted"
        >
          <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
          Reading completed runs…
        </div>
        <UAlert
          v-else-if="runsError"
          color="error"
          variant="soft"
          title="Recent runs are unavailable"
          description="The durable bundles remain authoritative even when this projection cannot be read."
        />
        <div v-else-if="recentRuns.length" class="divide-y divide-default">
          <NuxtLink
            v-for="run in recentRuns"
            :key="run.runId"
            :to="`/runs/${encodeURIComponent(run.runId)}`"
            :aria-label="runTitle(run)"
            class="grid gap-3 py-4 first:pt-0 last:pb-0 hover:text-primary sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div class="min-w-0">
              <p class="truncate font-bold">{{ runTitle(run) }}</p>
              <p class="mt-1 truncate text-sm text-muted">
                {{ run.recipeLabel }} · {{ runContext(run) }}
              </p>
            </div>
            <div class="flex items-center gap-3 text-xs text-muted">
              <span>{{ run.acceptedCount }} accepted</span>
              <time :datetime="run.completedAt">{{ formatDate(run.completedAt) }}</time>
              <UIcon name="i-lucide-chevron-right" class="size-4" aria-hidden="true" />
            </div>
          </NuxtLink>
        </div>
        <div v-else class="py-6">
          <p class="font-semibold text-highlighted">No completed runs yet.</p>
          <p class="mt-1 text-sm text-muted">
            Finished analyses will appear here after their portable run bundle is sealed and projected.
          </p>
        </div>
      </UCard>
    </section>
  </main>
</template>
