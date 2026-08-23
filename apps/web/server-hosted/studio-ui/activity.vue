<script setup lang="ts">
import type { AnalysisJob } from "../../../../src/domain/studio-schemas.js";
import type { HostedJobView } from "../../../workflows/src/contracts.js";
import { derivePermittedActivityActions } from "../../app/studio/activity-actions.js";
import {
  activityDisplayState,
  activityStageLabel,
  formatRelativeActivity,
  recipeDisplayLabel,
} from "../../app/studio/activity-state.js";
import { hostedJobAsActivity } from "./hosted-adapter";
import { recordingDisplayLabel } from "../../app/studio/recording-display";

useSeoMeta({
  title: "Activity · Frame of Mind",
  description: "See hosted analyses and how they are going.",
});
const hostedPage = useState<{ jobs: HostedJobView[] }>("hosted-activity-page", () => ({ jobs: [] }));
const clock = useState("hosted-activity-clock", () => Date.now());
const notice = ref("");
const requestFetch = useRequestFetch();
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh(): Promise<void> {
  try {
    hostedPage.value = await requestFetch<{ jobs: HostedJobView[] }>("/api/hosted/jobs");
    notice.value = "";
  } catch {
    if (hostedPage.value.jobs.length === 0) {
      throw createError({ statusCode: 404, statusMessage: "Not found" });
    }
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
const jobs = computed<AnalysisJob[]>(() =>
  hostedPage.value.jobs.map((job) => hostedJobAsActivity(job))
);
const recipeLabels = computed(() =>
  new Map(hostedPage.value.jobs.map((job) => [job.id, job.receipt.recipe.label]))
);
const hostedJobsById = computed(() =>
  new Map(hostedPage.value.jobs.map((job) => [job.id, job]))
);
function label(job: AnalysisJob): string {
  return recipeLabels.value.get(job.id) || recipeDisplayLabel(job.input.recipe.id);
}
function relative(value: string): string {
  return formatRelativeActivity(value, new Date(clock.value));
}
function statusColor(job: AnalysisJob): "info" | "success" | "error" | "warning" | "neutral" {
  const state = activityDisplayState(job.stage);
  if (state === "active") return "info";
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "interrupted") return "error";
  if (state === "canceled") return "neutral";
  return "warning";
}
function recordingLabel(job: AnalysisJob): string {
  const hostedJob = hostedJobsById.value.get(job.id);
  return hostedJob?.receipt.recording
    ? recordingDisplayLabel(hostedJob.receipt.recording)
    : "Recording details unavailable";
}
function canCancel(job: AnalysisJob): boolean {
  return derivePermittedActivityActions({ job, media: undefined, projection: "unknown", now: new Date(clock.value).toISOString() }).actions.some((item) => item.id === "cancel");
}
async function cancel(job: AnalysisJob): Promise<void> {
  await $fetch(`/api/hosted/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST", body: {} });
  await refresh();
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-activity-page="list">
    <div class="flex items-end justify-between gap-4"><div><h1 class="text-4xl font-black">Activity</h1><p class="mt-3 text-muted">Analyses you've started, and how they're going.</p></div><UButton label="Refresh" icon="i-lucide-refresh-cw" color="neutral" variant="outline" @click="refresh" /></div>
    <UAlert v-if="notice" class="mt-6" color="warning" :description="notice" />
    <UCard v-if="jobs.length === 0" class="mt-8 text-center">
      <h2 class="text-xl font-black">No analyses yet</h2>
      <p class="mt-2 text-sm text-muted">Start an analysis to see its progress here.</p>
      <UButton class="mt-5" to="/hosted/new/intent" label="Start an analysis" icon="i-lucide-plus" />
    </UCard>
    <UCard v-else class="mt-8">
      <ul class="divide-y divide-default">
        <li v-for="job in jobs" :key="job.id" class="flex flex-wrap items-center justify-between gap-4 py-4">
          <div>
            <NuxtLink :to="`/hosted/activity/${encodeURIComponent(job.id)}`" class="font-bold hover:text-primary">
              {{ label(job) }}<template v-if="job.attempt > 1"> · Try {{ job.attempt }}</template>
            </NuxtLink>
            <p class="mt-1 text-sm text-muted">
              {{ recordingLabel(job) }} · Started
              <time :datetime="job.createdAt" :title="job.createdAt">{{ relative(job.createdAt) }}</time>
            </p>
          </div>
          <div class="flex items-center gap-3">
            <UBadge :color="statusColor(job)" variant="soft">{{ activityStageLabel(job.stage) }}</UBadge>
            <UButton v-if="canCancel(job)" label="Cancel" size="xs" color="neutral" variant="outline" @click="cancel(job)" />
          </div>
        </li>
      </ul>
    </UCard>
  </main>
</template>
