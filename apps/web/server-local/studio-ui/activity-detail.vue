<script setup lang="ts">
import type { AnalysisJob } from "../../../../src/domain/studio-schemas";
import {
  activityDisplayState,
  activityStageLabel,
  deriveActivityTimeline,
  recipeDisplayLabel,
} from "./activity-state";
import {
  createJobActivityTransport,
  useJobActivity,
  type StudioJobDetail,
} from "./use-job-activity";

useSeoMeta({
  title: "Job activity · Frame of Mind",
  description: "Review one private local job timeline and immutable input receipt.",
});

type StatusColor = "primary" | "success" | "error" | "warning" | "neutral";

const route = useRoute();
const jobId = computed(() =>
  Array.isArray(route.params.id) ? route.params.id[0] ?? "" : String(route.params.id ?? "")
);
const transport = createJobActivityTransport();
const {
  data: detail,
  loading,
  notice,
  refreshing,
  refresh,
} = useJobActivity<StudioJobDetail | undefined>({
  initial: undefined,
  load: () => transport.detail(jobId.value),
  terminal: (value) => Boolean(value && [
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
  ].includes(value.job.stage)),
});
const timeline = computed(() => deriveActivityTimeline(detail.value?.events ?? []));

function stateColor(job: AnalysisJob): StatusColor {
  const state = activityDisplayState(job.stage);
  if (state === "succeeded") return "success";
  if (state === "failed") return "error";
  if (state === "canceled" || state === "interrupted") return "warning";
  return job.stage === "queued" ? "neutral" : "primary";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function contextLabel(job: AnalysisJob): string {
  if ("mode" in job.input.context) return "Video only";
  if (job.input.context.provider === "file") return "Local context file";
  return `${recipeDisplayLabel(job.input.context.provider)} via ${job.input.context.transport.toUpperCase()}`;
}

function retentionLabel(job: AnalysisJob): string {
  if (job.input.retention.mode === "ephemeral") {
    return "Delete staged recording after cleanup";
  }
  return `Retain staged recording until ${formatDate(job.input.retention.expiresAt)}`;
}

function terminalMessage(job: AnalysisJob): string {
  return job.terminal?.message
    ?? (job.stage === "failed"
      ? "This analysis stopped before it completed."
      : job.stage === "canceled"
        ? "This analysis was canceled."
        : "This analysis stopped when the local process ended.");
}
</script>

<template>
  <main class="fom-shell py-8 sm:py-10" data-activity-detail="local">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <UButton
        to="/activity"
        color="neutral"
        variant="ghost"
        icon="i-lucide-arrow-left"
        label="All activity"
      />
      <UButton
        type="button"
        color="neutral"
        variant="outline"
        icon="i-lucide-refresh-cw"
        label="Refresh"
        :loading="refreshing"
        @click="refresh"
      />
    </div>

    <p class="sr-only" aria-live="polite">
      {{ notice || (refreshing ? "Refreshing job activity." : "Job activity is up to date.") }}
    </p>
    <UAlert
      v-if="notice"
      class="mt-6"
      color="warning"
      variant="soft"
      icon="i-lucide-triangle-alert"
      title="Refresh paused"
      :description="notice"
    />

    <div v-if="loading" class="mt-8 flex items-center gap-3 text-sm text-muted" role="status">
      <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
      Reading the job timeline…
    </div>

    <UAlert
      v-else-if="!detail"
      class="mt-8"
      color="error"
      variant="soft"
      title="Job activity is unavailable"
      description="Return to Activity and choose the job again."
    />

    <template v-else>
      <section class="mt-8 flex flex-wrap items-start justify-between gap-5">
        <div>
          <p class="fom-kicker text-primary">Job activity</p>
          <h1 class="mt-3 text-4xl font-black tracking-[-0.045em] sm:text-5xl">
            {{ recipeDisplayLabel(detail.job.input.recipe.id) }}
          </h1>
          <p class="mt-3 text-sm text-muted">
            Created <time :datetime="detail.job.createdAt">{{ formatDate(detail.job.createdAt) }}</time>
            · attempt {{ detail.job.attempt }}
          </p>
        </div>
        <UBadge :color="stateColor(detail.job)" variant="soft" size="lg">
          {{ activityStageLabel(detail.job.stage) }}
        </UBadge>
      </section>

      <UAlert
        v-if="detail.job.stage === 'succeeded'"
        class="mt-6"
        color="success"
        variant="soft"
        icon="i-lucide-check-circle"
        title="Analysis completed"
        description="The durable run is ready to review."
        :actions="detail.job.runId ? [{ label: 'Open completed run', to: `/runs/${encodeURIComponent(detail.job.runId)}` }] : []"
      />
      <UAlert
        v-else-if="['failed', 'canceled', 'interrupted'].includes(detail.job.stage)"
        class="mt-6"
        :color="detail.job.stage === 'failed' ? 'error' : 'warning'"
        variant="soft"
        icon="i-lucide-triangle-alert"
        :title="activityStageLabel(detail.job.stage)"
        :description="terminalMessage(detail.job)"
      />

      <section class="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)]">
        <UCard aria-labelledby="job-timeline-heading">
          <template #header>
            <div>
              <p class="fom-kicker text-muted">Stage history</p>
              <h2 id="job-timeline-heading" class="mt-2 text-2xl font-black">Timeline</h2>
            </div>
          </template>
          <ol v-if="timeline.length" class="space-y-5" aria-label="Job stage timeline">
            <li v-for="row in timeline" :key="row.key" class="relative border-l-2 border-default pl-5">
              <span class="absolute -left-[0.42rem] top-1.5 size-3 rounded-full border-2 border-default bg-default" aria-hidden="true" />
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p class="font-black text-highlighted">{{ row.label }}</p>
                  <p class="mt-1 text-sm text-muted">{{ row.message }}</p>
                </div>
                <time :datetime="row.occurredAt" class="text-xs text-muted">
                  {{ formatDate(row.occurredAt) }}
                </time>
              </div>
              <ul v-if="row.type === 'transition' && row.progress.length" class="mt-3 space-y-2 border-l border-default pl-4">
                <li v-for="progress in row.progress" :key="progress.sequence" class="flex flex-wrap justify-between gap-2 text-sm">
                  <span>{{ progress.label }}</span>
                  <time :datetime="progress.occurredAt" class="text-xs text-muted">{{ formatDate(progress.occurredAt) }}</time>
                </li>
              </ul>
            </li>
          </ol>
          <p v-else class="py-5 text-sm text-muted">No stage changes have been recorded yet.</p>
        </UCard>

        <div class="space-y-6">
          <UCard aria-labelledby="job-input-heading">
            <template #header>
              <div>
                <p class="fom-kicker text-muted">Immutable input</p>
                <h2 id="job-input-heading" class="mt-2 text-2xl font-black">Run receipt</h2>
              </div>
            </template>
            <dl class="space-y-4 text-sm">
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Recipe</dt>
                <dd class="mt-1 font-semibold">{{ recipeDisplayLabel(detail.job.input.recipe.id) }}</dd>
                <dd class="mt-1 text-xs text-muted">Revision {{ detail.job.input.recipe.revision }}</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Context</dt>
                <dd class="mt-1">{{ contextLabel(detail.job) }}</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Model</dt>
                <dd class="mt-1 break-words">{{ detail.job.input.model }}</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Retention</dt>
                <dd class="mt-1">{{ retentionLabel(detail.job) }}</dd>
              </div>
            </dl>
          </UCard>

          <UCard aria-labelledby="job-actions-heading">
            <template #header>
              <h2 id="job-actions-heading" class="text-lg font-black">Actions</h2>
            </template>
            <p class="text-sm text-muted">
              Cancel and retry actions arrive in Task 7.2. This space is kept
              open for controls that follow the job state safely.
            </p>
          </UCard>
        </div>
      </section>
    </template>
  </main>
</template>
