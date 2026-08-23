<script setup lang="ts">
import type { AnalysisJob, MediaSession } from "../../../../src/domain/studio-schemas.js";
import type { HostedJobView, HostedMediaView } from "../../../workflows/src/contracts.js";
import type { HostedEventView } from "../../../workflows/src/repository.js";
import { derivePermittedActivityActions } from "../../app/studio/activity-actions.js";
import { deriveActivityProgress } from "../../app/studio/activity-progress.js";
import {
  activityStageLabel,
  deriveActivityTimeline,
  formatRelativeActivity,
  recipeDisplayLabel,
  type TimelineRow,
} from "../../app/studio/activity-state.js";
import { hostedEventsAsActivity, hostedJobAsActivity, hostedMediaSession } from "./hosted-adapter";

const route = useRoute();
const job = ref<AnalysisJob>();
const recipeLabel = ref("Analysis");
const media = ref<MediaSession>();
const events = ref<ReturnType<typeof hostedEventsAsActivity>>([]);
const notice = ref("");
const supportMessage = ref("");
const requestFetch = useRequestFetch();
useSeoMeta({
  title: () => `${recipeLabel.value} · Activity · Frame of Mind`,
  description: "Review the progress and details of a hosted analysis.",
});
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh(): Promise<void> {
  try {
    const response = await requestFetch<{ job: HostedJobView; media?: HostedMediaView; events: HostedEventView[] }>(`/api/hosted/jobs/${encodeURIComponent(String(route.params.id))}`);
    job.value = hostedJobAsActivity(response.job, response.media);
    recipeLabel.value = response.job.receipt.recipe.label
      || recipeDisplayLabel(response.job.receipt.recipe.id);
    media.value = response.media
      ? hostedMediaSession(
          response.media,
          response.media.retention === "retained" ? "retained" : "sealed",
        )
      : undefined;
    events.value = hostedEventsAsActivity(response.job, response.events);
    notice.value = "";
  } catch {
    if (!job.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
    notice.value = "Lost connection — retrying.";
  }
}
await refresh();
onMounted(() => { timer = setInterval(() => void refresh(), 2_000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
const timeline = computed(() => deriveActivityTimeline(events.value));
const actions = computed(() => job.value
  ? derivePermittedActivityActions({ job: job.value, media: media.value, projection: job.value.runId ? "present" : "unknown", now: new Date().toISOString() })
  : { actions: [] });
const progress = computed(() => job.value ? deriveActivityProgress(job.value, events.value, new Date()) : undefined);
const terminal = computed(() => progress.value?.descriptor.kind === "terminal");
function relative(value: string): string {
  return formatRelativeActivity(value, new Date());
}
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function timelineMessage(row: TimelineRow): string {
  if (row.type === "notice") return row.message;
  const messages: Partial<Record<AnalysisJob["stage"], string>> = {
    queued: "Waiting for analysis to begin.",
    fetching_context: "Checking the selected sources.",
    uploading_to_gemini: "Sending the recording securely.",
    indexing: "Finding the moments that match your goal.",
    interrogating: "Reviewing the selected moments in detail.",
    rendering: "Preparing your results.",
    cleaning_up: "Removing the Gemini upload and publishing results.",
    succeeded: "Results are ready.",
    failed: "Analysis stopped before results were ready.",
    canceled: "Analysis was canceled.",
    interrupted: "Analysis was interrupted.",
  };
  return messages[row.stage] || row.label;
}
const retentionText = computed(() => {
  if (!job.value) return "Unavailable";
  if (job.value.input.retention.mode === "retained") {
    return `Recording kept until ${formatDate(job.value.input.retention.expiresAt)}`;
  }
  return "Recording deleted after analysis";
});
async function cancel(): Promise<void> {
  await $fetch(`/api/hosted/jobs/${encodeURIComponent(job.value!.id)}/cancel`, { method: "POST", body: {} });
  await refresh();
}
async function retry(): Promise<void> {
  const response = await $fetch<{ job: HostedJobView }>(`/api/hosted/jobs/${encodeURIComponent(job.value!.id)}/retry`, { method: "POST", body: { idempotencyKey: `hosted-retry:${crypto.randomUUID()}` } });
  await navigateTo(`/hosted/activity/${encodeURIComponent(response.job.id)}`);
}
async function copySupportDetails(): Promise<void> {
  supportMessage.value = "";
  try {
    const receipt = await $fetch<string>(
      `/api/hosted/jobs/${encodeURIComponent(job.value!.id)}/support-receipt`,
      { responseType: "text" },
    );
    await navigator.clipboard.writeText(receipt);
    supportMessage.value = "Details copied.";
  } catch {
    supportMessage.value = "Could not copy details. Try again.";
  }
}
</script>

<template>
  <main v-if="job" class="fom-shell py-8" data-hosted-activity-page="detail">
    <NuxtLink to="/hosted/activity" class="text-sm font-bold text-primary">← Activity</NuxtLink>
    <div class="mt-5 flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="fom-kicker text-primary">{{ job.attempt > 1 ? `Try ${job.attempt}` : "Analysis" }}</p>
        <h1 class="mt-3 text-4xl font-black">{{ recipeLabel }}</h1>
        <p class="mt-3 text-muted">Started <time :datetime="job.createdAt" :title="job.createdAt">{{ relative(job.createdAt) }}</time></p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <UBadge size="lg">{{ activityStageLabel(job.stage) }}</UBadge>
        <UButton v-if="job.runId" :to="`/runs/${encodeURIComponent(job.runId)}`" label="Open published run" icon="i-lucide-arrow-right" />
      </div>
    </div>
    <UAlert v-if="notice" class="mt-6" color="warning" :description="notice" />
    <UProgress v-if="!terminal" class="mt-6" animation="carousel" aria-label="Analysis in progress" />
    <UCard class="mt-8">
      <template #header><h2 class="text-xl font-black">Details</h2></template>
      <dl class="grid gap-4 text-sm md:grid-cols-3">
        <div><dt class="text-muted">Model</dt><dd>{{ job.input.model }}</dd></div>
        <div><dt class="text-muted">Recording</dt><dd>{{ retentionText }}</dd></div>
        <div><dt class="text-muted">Updated</dt><dd><time :datetime="job.updatedAt" :title="job.updatedAt">{{ relative(job.updatedAt) }}</time></dd></div>
      </dl>
      <p v-if="job.terminal?.code" class="mt-4 text-sm">Status code: <code>{{ job.terminal.code }}</code></p>
      <div class="mt-5 flex flex-wrap gap-3"><UButton v-if="actions.actions.some((item) => item.id === 'cancel')" label="Cancel" color="neutral" variant="outline" @click="cancel" /><UButton v-if="actions.actions.some((item) => item.id === 'retry')" label="Try again" @click="retry" /><UButton label="Copy details for support" icon="i-lucide-copy" color="neutral" variant="outline" @click="copySupportDetails" /></div>
      <p v-if="supportMessage" class="mt-3 text-sm text-muted" role="status">{{ supportMessage }}</p>
      <p v-if="actions.whyNot && job.stage !== 'succeeded'" class="mt-4 text-sm text-muted">{{ actions.whyNot }}</p>
    </UCard>
    <UCard class="mt-6">
      <template #header><h2 class="text-xl font-black">Timeline</h2></template>
      <ol class="space-y-4">
        <li v-for="row in timeline" :key="row.key">
          <p class="font-bold">{{ row.label }}</p>
          <p class="text-sm text-muted">{{ timelineMessage(row) }}</p>
          <time class="text-xs text-dimmed" :datetime="row.occurredAt" :title="row.occurredAt">{{ relative(row.occurredAt) }}</time>
        </li>
      </ol>
    </UCard>
  </main>
</template>
