<script setup lang="ts">
import type { AnalysisJob } from "../../../../src/domain/studio-schemas";
import ActivityActionPanel from "./activity-action-panel.vue";
import {
  activityDisplayState,
  activityStageLabel,
  activityStageChangeAnnouncement,
  deriveActivityTimeline,
  recipeDisplayLabel,
} from "./activity-state";
import { deriveActivityProgress } from "./activity-progress";
import {
  buildActivityTechnicalDetails,
  formatActivitySupportReceipt,
} from "./activity-support-receipt";
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
const now = ref(Date.now());
const stageAnnouncement = ref("");
let previousJob: AnalysisJob | undefined;
watch(detail, (value) => {
  now.value = Date.now();
  if (!value) return;
  if (previousJob) {
    const announcement = activityStageChangeAnnouncement([previousJob], [value.job]);
    if (announcement) stageAnnouncement.value = announcement;
  }
  previousJob = value.job;
});
const activityProgress = computed(() => detail.value
  ? deriveActivityProgress(detail.value.job, detail.value.events, now.value)
  : undefined
);
const technicalDetails = computed(() => detail.value
  ? buildActivityTechnicalDetails({
      job: detail.value.job,
      events: detail.value.events,
      media: detail.value.actionSnapshot.media,
    })
  : undefined
);
const supportReceipt = computed(() => technicalDetails.value
  ? formatActivitySupportReceipt(technicalDetails.value)
  : ""
);
const copyMessage = ref("");
const showReceiptFallback = ref(false);
const receiptFallback = ref<HTMLTextAreaElement>();

async function copySupportReceipt(): Promise<void> {
  showReceiptFallback.value = false;
  copyMessage.value = "";
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
    await navigator.clipboard.writeText(supportReceipt.value);
    copyMessage.value = "Support receipt copied.";
  } catch {
    showReceiptFallback.value = true;
    copyMessage.value = "Clipboard unavailable. Copy the selected receipt below.";
    await nextTick();
    receiptFallback.value?.focus();
    receiptFallback.value?.select();
  }
}

function stateColor(job: AnalysisJob): StatusColor {
  const state = activityDisplayState(job.stage);
  if (state === "succeeded") return "success";
  if (state === "failed") return "error";
  if (state === "canceled" || state === "interrupted") return "warning";
  return job.stage === "queued" ? "neutral" : "primary";
}

function progressWidth(completed: number, total: number): string {
  return `${Math.min(100, Math.max(0, (completed / total) * 100))}%`;
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

function technicalTimestamp(value: string | null): string {
  return value ? formatDate(value) : "Not recorded";
}

function technicalDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (!minutes) return `${remainder} second${remainder === 1 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"} ${remainder} second${remainder === 1 ? "" : "s"}`;
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

    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ stageAnnouncement }}
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
        description="Your results are ready to review."
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

      <UCard
        v-if="activityProgress"
        class="mt-8"
        aria-labelledby="job-progress-heading"
        data-activity-progress="honest"
      >
        <template #header>
          <div>
            <p class="fom-kicker text-muted">Current work</p>
            <h2 id="job-progress-heading" class="mt-2 text-2xl font-black">
              Timing and progress
            </h2>
          </div>
        </template>
        <dl class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <dt class="text-xs font-bold uppercase tracking-wider text-muted">Elapsed</dt>
            <dd class="mt-2 text-xl font-black tabular-nums">
              <span
                :data-elapsed-seconds="activityProgress.elapsed.seconds"
                :data-terminal="activityProgress.descriptor.kind === 'terminal'"
              >
                <span aria-hidden="true">{{ activityProgress.elapsed.text }}</span>
                <span class="sr-only">{{ activityProgress.elapsed.accessibleText }}</span>
              </span>
            </dd>
          </div>
          <div>
            <dt class="text-xs font-bold uppercase tracking-wider text-muted">Last activity</dt>
            <dd class="mt-2 text-xl font-black">
              <time
                :datetime="activityProgress.lastActivityAt"
              >
                <span aria-hidden="true">{{ activityProgress.lastActivityText }}</span>
                <span class="sr-only">{{ activityProgress.lastActivityAccessibleText }}</span>
              </time>
            </dd>
          </div>
          <div>
            <dt class="text-xs font-bold uppercase tracking-wider text-muted">
              Current stage started
            </dt>
            <dd class="mt-2 text-sm font-semibold">
              <time :datetime="activityProgress.currentStageStartedAt">
                {{ formatDate(activityProgress.currentStageStartedAt) }}
              </time>
            </dd>
          </div>
          <div>
            <dt class="text-xs font-bold uppercase tracking-wider text-muted">Progress</dt>
            <dd class="mt-2">
              <p class="text-xl font-black">
                <span
                  :aria-hidden="activityProgress.descriptor.kind === 'determinate' || undefined"
                >
                  {{ activityProgress.descriptor.text }}
                </span>
              </p>
              <p
                v-if="'detail' in activityProgress.descriptor"
                class="mt-1 text-xs font-semibold uppercase tracking-wider text-muted"
                :aria-hidden="activityProgress.descriptor.kind === 'determinate' || undefined"
              >
                {{ activityProgress.descriptor.detail }}
              </p>
              <div
                v-if="activityProgress.descriptor.kind === 'determinate'"
                class="mt-3 h-2 overflow-hidden rounded-full bg-accented"
                role="progressbar"
                :aria-label="activityProgress.descriptor.accessibleText"
                aria-valuemin="0"
                :aria-valuenow="activityProgress.descriptor.completed"
                :aria-valuemax="activityProgress.descriptor.total"
              >
                <div
                  class="h-full rounded-full bg-primary"
                  :style="{ width: progressWidth(
                    activityProgress.descriptor.completed,
                    activityProgress.descriptor.total,
                  ) }"
                />
              </div>
            </dd>
          </div>
        </dl>
      </UCard>

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

          <UCard
            v-if="technicalDetails"
            data-technical-details="allowlisted"
          >
            <details>
              <summary class="cursor-pointer text-lg font-black focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
                Technical details
              </summary>
              <p class="mt-3 text-sm leading-6 text-muted">
                Sanitized codes and timing only. Private content and raw provider errors are excluded.
              </p>
              <dl class="mt-5 space-y-4 text-sm">
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Job ID</dt>
                  <dd class="mt-1 break-all font-mono">{{ technicalDetails.jobId }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Stage</dt>
                  <dd class="mt-1 font-mono">{{ technicalDetails.stage }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Terminal code</dt>
                  <dd class="mt-1 font-mono">{{ technicalDetails.terminalCode }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Created</dt>
                  <dd class="mt-1">{{ technicalTimestamp(technicalDetails.timestamps.createdAt) }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Updated</dt>
                  <dd class="mt-1">{{ technicalTimestamp(technicalDetails.timestamps.updatedAt) }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Terminal time</dt>
                  <dd class="mt-1">{{ technicalTimestamp(technicalDetails.timestamps.terminalAt) }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Cancellation requested</dt>
                  <dd class="mt-1">{{ technicalTimestamp(technicalDetails.timestamps.cancellationRequestedAt) }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Provider ID</dt>
                  <dd class="mt-1 font-mono">{{ technicalDetails.providerId }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Recipe ID</dt>
                  <dd class="mt-1 font-mono">{{ technicalDetails.recipeId }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Media retention state</dt>
                  <dd class="mt-1 font-mono">{{ technicalDetails.mediaRetentionState }}</dd>
                  <dd class="mt-1 text-xs text-muted">
                    Expires {{ technicalTimestamp(technicalDetails.mediaRetentionExpiresAt) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Cleanup state</dt>
                  <dd class="mt-1 font-mono">{{ technicalDetails.cleanupState }}</dd>
                </div>
                <div>
                  <dt class="text-xs font-bold uppercase tracking-wider text-muted">Stage durations</dt>
                  <dd class="mt-2">
                    <ul class="space-y-2">
                      <li
                        v-for="duration in technicalDetails.stageDurations"
                        :key="duration.stage"
                        class="flex flex-wrap justify-between gap-2"
                      >
                        <span class="font-mono">{{ duration.stage }}</span>
                        <span>{{ technicalDuration(duration.seconds) }}</span>
                      </li>
                    </ul>
                  </dd>
                </div>
              </dl>
              <UButton
                class="mt-6"
                type="button"
                color="neutral"
                variant="outline"
                icon="i-lucide-copy"
                label="Copy support receipt"
                @click="copySupportReceipt"
              />
              <p class="mt-3 text-sm font-semibold" role="status" aria-live="polite">
                {{ copyMessage }}
              </p>
              <div v-if="showReceiptFallback" class="mt-3">
                <label for="support-receipt-fallback" class="text-sm font-bold">
                  Support receipt text
                </label>
                <textarea
                  id="support-receipt-fallback"
                  ref="receiptFallback"
                  class="mt-2 min-h-64 w-full rounded-lg border border-default bg-default p-3 font-mono text-xs"
                  readonly
                  :value="supportReceipt"
                />
              </div>
            </details>
          </UCard>

          <UCard aria-labelledby="job-actions-heading">
            <template #header>
              <h2 id="job-actions-heading" class="text-lg font-black">Actions</h2>
            </template>
            <ActivityActionPanel :detail="detail" @refresh="refresh" />
          </UCard>
        </div>
      </section>
    </template>
  </main>
</template>
