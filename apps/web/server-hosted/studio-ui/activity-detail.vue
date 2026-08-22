<script setup lang="ts">
import type { AnalysisJob, MediaSession } from "../../../../src/domain/studio-schemas.js";
import type { HostedJobView, HostedMediaView } from "../../../workflows/src/contracts.js";
import type { HostedEventView } from "../../../workflows/src/repository.js";
import { derivePermittedActivityActions } from "../../app/studio/activity-actions.js";
import { deriveActivityProgress } from "../../app/studio/activity-progress.js";
import { activityStageLabel, deriveActivityTimeline } from "../../app/studio/activity-state.js";
import { hostedEventsAsActivity, hostedJobAsActivity, hostedMediaSession } from "./hosted-adapter";

const route = useRoute();
const job = ref<AnalysisJob>();
const media = ref<MediaSession>();
const events = ref<ReturnType<typeof hostedEventsAsActivity>>([]);
const notice = ref("");
const requestFetch = useRequestFetch();
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh(): Promise<void> {
  try {
    const response = await requestFetch<{ job: HostedJobView; media?: HostedMediaView; events: HostedEventView[] }>(`/api/hosted/jobs/${encodeURIComponent(String(route.params.id))}`);
    job.value = hostedJobAsActivity(response.job, response.media);
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
    notice.value = "Refresh paused.";
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
async function cancel(): Promise<void> {
  await $fetch(`/api/hosted/jobs/${encodeURIComponent(job.value!.id)}/cancel`, { method: "POST", body: {} });
  await refresh();
}
async function retry(): Promise<void> {
  const response = await $fetch<{ job: HostedJobView }>(`/api/hosted/jobs/${encodeURIComponent(job.value!.id)}/retry`, { method: "POST", body: { idempotencyKey: `hosted-retry:${crypto.randomUUID()}` } });
  await navigateTo(`/hosted/activity/${encodeURIComponent(response.job.id)}`);
}
</script>

<template>
  <main v-if="job" class="fom-shell py-8" data-hosted-activity-page="detail">
    <NuxtLink to="/hosted/activity" class="text-sm font-bold text-primary">← Activity</NuxtLink>
    <div class="mt-5 flex flex-wrap items-start justify-between gap-4"><div><p class="fom-kicker text-primary">Attempt {{ job.attempt }}</p><h1 class="mt-3 text-4xl font-black">{{ job.input.recipe.id }}</h1><p class="mt-3 text-muted">{{ activityStageLabel(job.stage) }} · {{ progress?.descriptor.accessibleText }}</p></div><UBadge size="lg">{{ activityStageLabel(job.stage) }}</UBadge></div>
    <UAlert v-if="notice" class="mt-6" color="warning" :description="notice" />
    <UCard class="mt-8">
      <template #header><h2 class="text-xl font-black">Receipt</h2></template>
      <dl class="grid gap-4 text-sm md:grid-cols-3"><div><dt class="text-muted">Model</dt><dd>{{ job.input.model }}</dd></div><div><dt class="text-muted">Retention</dt><dd>{{ job.input.retention.mode }}</dd></div><div><dt class="text-muted">Updated</dt><dd>{{ job.updatedAt }}</dd></div></dl>
      <p v-if="job.terminal?.code" class="mt-4 text-sm">Status code: <code>{{ job.terminal.code }}</code></p>
      <div class="mt-5 flex gap-3"><UButton v-if="actions.actions.some((item) => item.id === 'cancel')" label="Cancel" color="neutral" variant="outline" @click="cancel" /><UButton v-if="actions.actions.some((item) => item.id === 'retry')" label="Retry" @click="retry" /><UButton v-if="job.runId" :to="`/runs/${encodeURIComponent(job.runId)}`" label="Open published run" icon="i-lucide-external-link" /></div>
      <p v-if="actions.whyNot" class="mt-4 text-sm text-muted">{{ actions.whyNot }}</p>
    </UCard>
    <UCard class="mt-6"><template #header><h2 class="text-xl font-black">Timeline</h2></template><ol class="space-y-4"><li v-for="row in timeline" :key="row.key"><p class="font-bold">{{ row.label }}</p><p class="text-sm text-muted">{{ row.message }} · {{ row.occurredAt }}</p></li></ol></UCard>
  </main>
</template>
