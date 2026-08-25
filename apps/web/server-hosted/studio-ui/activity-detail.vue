<script setup lang="ts">
import type { AnalysisJob, MediaSession } from "../../../../src/domain/studio-schemas.js";
import type { HostedJobView, HostedMediaView } from "../../../workflows/src/contracts.js";
import type { HostedEventView } from "../../../workflows/src/repository.js";
import { derivePermittedActivityActions } from "../../app/studio/activity-actions.js";
import { deriveActivityProgress } from "../../app/studio/activity-progress.js";
import {
  activityDisplayState,
  activityStageLabel,
  deriveActivityTimeline,
  formatRelativeActivity,
  recipeDisplayLabel,
  type TimelineRow,
} from "../../app/studio/activity-state.js";
import { hostedEventsAsActivity, hostedJobAsActivity, hostedMediaSession } from "./hosted-adapter";

const route = useRoute();
type HostedActivityDetail = { job: HostedJobView; media?: HostedMediaView; events: HostedEventView[] };
const stateKey = `hosted-activity-detail:${String(route.params.id)}`;
const hostedDetail = useState<HostedActivityDetail | undefined>(stateKey, () => undefined);
const clock = useState(`${stateKey}:clock`, () => Date.now());
const notice = ref("");
const supportMessage = ref("");
const requestFetch = useRequestFetch();
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh(): Promise<void> {
  try {
    hostedDetail.value = await requestFetch<HostedActivityDetail>(`/api/hosted/jobs/${encodeURIComponent(String(route.params.id))}`);
    notice.value = "";
  } catch {
    if (!hostedDetail.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
    notice.value = "Lost connection — retrying.";
  }
}
await refresh();
onMounted(() => {
  timer = setInterval(() => {
    clock.value = Date.now();
    void refresh();
  }, 2_000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
const job = computed(() => hostedDetail.value
  ? hostedJobAsActivity(hostedDetail.value.job, hostedDetail.value.media)
  : undefined
);
const recipeLabel = computed(() => hostedDetail.value?.job.receipt.recipe.label
  || (hostedDetail.value ? recipeDisplayLabel(hostedDetail.value.job.receipt.recipe.id) : "Analysis")
);
const media = computed(() => hostedDetail.value?.media
  ? hostedMediaSession(
      hostedDetail.value.media,
      hostedDetail.value.media.retention === "retained" ? "retained" : "sealed",
    )
  : undefined
);
const events = computed(() => hostedDetail.value
  ? hostedEventsAsActivity(hostedDetail.value.job, hostedDetail.value.events)
  : []
);
useSeoMeta({
  title: () => `${recipeLabel.value} · Activity · Frame of Mind`,
  description: "Review the progress and details of a hosted analysis.",
});
const timeline = computed(() => deriveActivityTimeline(events.value));
const actions = computed(() => job.value
  ? derivePermittedActivityActions({ job: job.value, media: media.value, projection: job.value.runId ? "present" : "unknown", now: new Date(clock.value).toISOString() })
  : { actions: [] });
const progress = computed(() => job.value ? deriveActivityProgress(job.value, events.value, new Date(clock.value)) : undefined);
const terminal = computed(() => progress.value?.descriptor.kind === "terminal");
const terminalFailure = computed(() =>
  job.value?.stage === "failed" || job.value?.stage === "interrupted"
);
function statusColor(value: AnalysisJob): "info" | "success" | "error" | "warning" | "neutral" {
  const state = activityDisplayState(value.stage);
  if (state === "active") return "info";
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "interrupted") return "error";
  if (state === "canceled") return "neutral";
  return "warning";
}
function relative(value: string): string {
  return formatRelativeActivity(value, new Date(clock.value));
}
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
}
function timelineMessage(row: TimelineRow): string {
  if (row.type === "notice") return row.message;
  if (row.stage === "cleaning_up" && terminalFailure.value) {
    return "Removing the Gemini upload before stopping.";
  }
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
    <a href="/hosted/activity" class="text-sm font-bold text-primary">← Activity</a>
    <div class="mt-5 flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="fom-kicker text-primary">{{ job.attempt > 1 ? `Try ${job.attempt}` : "Analysis" }}</p>
        <h1 class="mt-3 text-4xl font-black">{{ recipeLabel }}</h1>
        <p class="mt-3 text-muted">Started <time :datetime="job.createdAt" :title="job.createdAt">{{ relative(job.createdAt) }}</time></p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <UBadge size="lg" :color="statusColor(job)">{{ activityStageLabel(job.stage) }}</UBadge>
        <UButton v-if="job.runId" :to="`/runs/${encodeURIComponent(job.runId)}`" external label="View results" icon="i-lucide-arrow-right" />
        <UButton v-if="terminalFailure" to="/hosted/new/intent" external label="Start a new analysis" icon="i-lucide-plus" />
      </div>
    </div>
    <UAlert v-if="notice" class="mt-6" color="warning" :description="notice" />
    <UProgress v-if="!terminal" class="mt-6" animation="carousel" aria-label="Analysis in progress" />
    <UCard class="mt-8">
      <template #header><h2 class="text-xl font-black">Details</h2></template>
      <dl class="grid gap-4 text-sm md:grid-cols-3">
        <div><dt class="text-muted">Analysis provider</dt><dd>Gemini</dd></div>
        <div><dt class="text-muted">Recording</dt><dd>{{ retentionText }}</dd></div>
        <div><dt class="text-muted">Updated</dt><dd><time :datetime="job.updatedAt" :title="job.updatedAt">{{ relative(job.updatedAt) }}</time></dd></div>
      </dl>
      <p v-if="job.terminal?.code" class="mt-4 text-sm">Support code: <code>{{ job.terminal.code }}</code></p>
      <div class="mt-5 flex flex-wrap gap-3"><UButton v-if="actions.actions.some((item) => item.id === 'cancel')" label="Cancel" color="neutral" variant="outline" @click="cancel" /><UButton v-if="actions.actions.some((item) => item.id === 'retry')" label="Try again" @click="retry" /><UButton v-if="job.runId" :to="`/review/${encodeURIComponent(job.runId)}`" external label="Open review workspace" icon="i-lucide-external-link" /><UButton label="Copy details for support" icon="i-lucide-copy" color="neutral" variant="outline" @click="copySupportDetails" /></div>
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
