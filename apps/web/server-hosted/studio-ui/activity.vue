<script setup lang="ts">
import type { AnalysisJob } from "../../../../src/domain/studio-schemas.js";
import type { HostedJobView } from "../../../workflows/src/contracts.js";
import { derivePermittedActivityActions } from "../../app/studio/activity-actions.js";
import { deriveActivityProgress } from "../../app/studio/activity-progress.js";
import { activityStageLabel, groupActivityJobs } from "../../app/studio/activity-state.js";
import { hostedJobAsActivity } from "./hosted-adapter";

const jobs = ref<AnalysisJob[]>([]);
const loading = ref(true);
const notice = ref("");
const requestFetch = useRequestFetch();
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh(): Promise<void> {
  try {
    const page = await requestFetch<{ jobs: HostedJobView[] }>("/api/hosted/jobs");
    jobs.value = page.jobs.map((job) => hostedJobAsActivity(job));
    notice.value = "";
  } catch {
    if (loading.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
    notice.value = "Activity refresh paused. Existing receipts remain on screen.";
  } finally {
    loading.value = false;
  }
}
await refresh();
onMounted(() => { timer = setInterval(() => void refresh(), 2_000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
const grouped = computed(() => groupActivityJobs(jobs.value));
const groups = [
  { key: "active" as const, label: "Active" },
  { key: "finished" as const, label: "Finished" },
  { key: "needs-attention" as const, label: "Needs attention" },
];
function progress(job: AnalysisJob): string {
  return deriveActivityProgress(job, [], new Date()).descriptor.accessibleText;
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
    <div class="flex items-end justify-between gap-4"><div><p class="fom-kicker text-primary">Hosted Studio</p><h1 class="mt-3 text-4xl font-black">Activity</h1><p class="mt-3 text-muted">Principal-bound analysis attempts and sanitized status receipts.</p></div><UButton label="Refresh" icon="i-lucide-refresh-cw" color="neutral" variant="outline" @click="refresh" /></div>
    <UAlert v-if="notice" class="mt-6" color="warning" :description="notice" />
    <div class="mt-8 space-y-6">
      <UCard v-for="group in groups" :key="group.key">
        <template #header><h2 class="text-xl font-black">{{ group.label }} <UBadge color="neutral">{{ grouped[group.key].length }}</UBadge></h2></template>
        <p v-if="!grouped[group.key].length" class="text-sm text-muted">No attempts in this group.</p>
        <ul v-else class="divide-y divide-default">
          <li v-for="job in grouped[group.key]" :key="job.id" class="flex flex-wrap items-center justify-between gap-4 py-4">
            <NuxtLink :to="`/hosted/activity/${encodeURIComponent(job.id)}`" class="font-bold hover:text-primary">{{ job.input.recipe.id }} · attempt {{ job.attempt }}</NuxtLink>
            <div class="flex items-center gap-3"><span class="text-sm text-muted">{{ activityStageLabel(job.stage) }} · {{ progress(job) }}</span><UButton v-if="canCancel(job)" label="Cancel" size="xs" color="neutral" variant="outline" @click="cancel(job)" /></div>
          </li>
        </ul>
      </UCard>
    </div>
  </main>
</template>
