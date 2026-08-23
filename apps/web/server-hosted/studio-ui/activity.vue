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

useSeoMeta({
  title: "Activity · Frame of Mind",
  description: "See hosted analyses and how they are going.",
});
const jobs = ref<AnalysisJob[]>([]);
const recipeLabels = ref(new Map<string, string>());
const loading = ref(true);
const notice = ref("");
const requestFetch = useRequestFetch();
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh(): Promise<void> {
  try {
    const page = await requestFetch<{ jobs: HostedJobView[] }>("/api/hosted/jobs");
    jobs.value = page.jobs.map((job) => hostedJobAsActivity(job));
    recipeLabels.value = new Map(page.jobs.map((job) => [job.id, job.receipt.recipe.label]));
    notice.value = "";
  } catch {
    if (loading.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
    notice.value = "Lost connection — retrying.";
  } finally {
    loading.value = false;
  }
}
await refresh();
onMounted(() => { timer = setInterval(() => void refresh(), 2_000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
function label(job: AnalysisJob): string {
  return recipeLabels.value.get(job.id) || recipeDisplayLabel(job.input.recipe.id);
}
function relative(value: string): string {
  return formatRelativeActivity(value, new Date());
}
function statusColor(job: AnalysisJob): "primary" | "success" | "error" | "warning" | "neutral" {
  const state = activityDisplayState(job.stage);
  if (state === "active") return "primary";
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "interrupted") return "error";
  if (state === "canceled") return "neutral";
  return "warning";
}
function canCancel(job: AnalysisJob): boolean {
  return derivePermittedActivityActions({ job, media: undefined, projection: "unknown", now: new Date().toISOString() }).actions.some((item) => item.id === "cancel");
}
async function cancel(job: AnalysisJob): Promise<void> {
  await $fetch(`/api/hosted/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST", body: {} });
  await refresh();
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-activity-page="list">
    <div class="flex items-end justify-between gap-4"><div><p class="fom-kicker text-primary">Hosted Studio</p><h1 class="mt-3 text-4xl font-black">Activity</h1><p class="mt-3 text-muted">Analyses you've started, and how they're going.</p></div><UButton label="Refresh" icon="i-lucide-refresh-cw" color="neutral" variant="outline" @click="refresh" /></div>
    <UAlert v-if="notice" class="mt-6" color="warning" :description="notice" />
    <USkeleton v-if="loading" class="mt-8 h-32 w-full" />
    <UCard v-else-if="jobs.length === 0" class="mt-8 text-center">
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
              Started <time :datetime="job.createdAt" :title="job.createdAt">{{ relative(job.createdAt) }}</time>
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
