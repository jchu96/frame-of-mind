<script setup lang="ts">
import type { AnalysisJob } from "../../../../src/domain/studio-schemas";
import {
  activityDisplayState,
  activityStageLabel,
  formatRelativeActivity,
  groupActivityJobs,
  recipeDisplayLabel,
  type ActivityGroup,
} from "./activity-state";
import {
  createJobActivityTransport,
  useJobActivity,
} from "./use-job-activity";

useSeoMeta({
  title: "Activity · Frame of Mind",
  description: "Follow private local analysis jobs from queue to completion.",
});

type StatusColor = "primary" | "success" | "error" | "warning" | "neutral";

const transport = createJobActivityTransport();
const {
  data: jobPage,
  loading,
  notice,
  refreshing,
  refresh,
} = useJobActivity({
  initial: { jobs: [] },
  load: () => transport.list(),
  terminal: (page) => page.jobs.every((job) =>
    ["succeeded", "failed", "canceled", "interrupted"].includes(job.stage)
  ),
});
const { data: recipeCatalog } = await useFetch<{
  recipes: Array<{ id: string; label: string }>;
}>("/api/studio/recipes", { server: false });
const now = ref(Date.now());

watch(jobPage, () => {
  now.value = Date.now();
});

const grouped = computed(() => groupActivityJobs(jobPage.value.jobs));
const sections: Array<{
  key: ActivityGroup;
  title: string;
  description: string;
  empty: string;
}> = [
  {
    key: "active",
    title: "Active",
    description: "Queued or working locally",
    empty: "No jobs are waiting or running.",
  },
  {
    key: "finished",
    title: "Finished",
    description: "Completed runs",
    empty: "No jobs have completed yet.",
  },
  {
    key: "needs-attention",
    title: "Needs attention",
    description: "Failed, canceled, or interrupted work",
    empty: "No jobs need attention.",
  },
];

function recipeLabel(job: AnalysisJob): string {
  return recipeCatalog.value?.recipes.find((recipe) =>
    recipe.id === job.input.recipe.id
  )?.label ?? recipeDisplayLabel(job.input.recipe.id);
}

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
    timeStyle: "short",
  }).format(new Date(value));
}
</script>

<template>
  <main class="fom-shell py-8 sm:py-10" data-activity-page="local">
    <section class="flex flex-wrap items-end justify-between gap-5">
      <div>
        <p class="fom-kicker text-primary">Local Studio</p>
        <h1 class="mt-3 text-4xl font-black tracking-[-0.045em] sm:text-5xl">
          Activity
        </h1>
        <p class="mt-4 max-w-2xl text-base leading-7 text-muted">
          Follow each private local job from the queue to its completed run or
          the point where it stopped.
        </p>
      </div>
      <UButton
        type="button"
        color="neutral"
        variant="outline"
        icon="i-lucide-refresh-cw"
        label="Refresh"
        :loading="refreshing"
        @click="refresh"
      />
    </section>

    <p class="sr-only" aria-live="polite">
      {{ notice || (refreshing ? "Refreshing activity." : "Activity is up to date.") }}
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

    <div
      v-if="loading"
      class="mt-8 flex items-center gap-3 text-sm text-muted"
      role="status"
    >
      <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
      Reading job activity…
    </div>

    <div v-else class="mt-8 space-y-6">
      <section
        v-for="section in sections"
        :key="section.key"
        :aria-labelledby="`activity-${section.key}`"
      >
        <UCard>
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 :id="`activity-${section.key}`" class="text-2xl font-black">
                  {{ section.title }}
                </h2>
                <p class="mt-1 text-sm text-muted">{{ section.description }}</p>
              </div>
              <UBadge color="neutral" variant="soft">
                {{ grouped[section.key].length }}
              </UBadge>
            </div>
          </template>

          <div v-if="grouped[section.key].length" class="overflow-x-auto">
            <table class="w-full min-w-[44rem] text-left" :aria-label="`${section.title} jobs`">
              <thead class="border-b border-default text-xs font-bold uppercase tracking-wider text-muted">
                <tr>
                  <th scope="col" class="pb-2 pr-4">Recipe</th>
                  <th scope="col" class="px-4 pb-2">Created</th>
                  <th scope="col" class="px-4 pb-2">Current stage</th>
                  <th scope="col" class="pb-2 pl-4">Last activity</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="job in grouped[section.key]" :key="job.id">
                  <td class="py-4 pr-4">
                    <NuxtLink
                      :to="`/activity/${encodeURIComponent(job.id)}`"
                      class="group flex min-w-0 items-center justify-between gap-3 font-bold hover:text-primary"
                      :aria-label="`${recipeLabel(job)}, ${activityStageLabel(job.stage)}`"
                    >
                      <span>
                        <span class="block truncate">{{ recipeLabel(job) }}</span>
                        <span class="mt-1 block text-xs font-normal text-muted">Attempt {{ job.attempt }}</span>
                      </span>
                      <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 transition group-hover:translate-x-0.5" aria-hidden="true" />
                    </NuxtLink>
                  </td>
                  <td class="px-4 py-4">
                    <time :datetime="job.createdAt" class="text-sm text-muted">
                      {{ formatDate(job.createdAt) }}
                    </time>
                  </td>
                  <td class="px-4 py-4">
                    <UBadge :color="stateColor(job)" variant="soft">
                      {{ activityStageLabel(job.stage) }}
                    </UBadge>
                  </td>
                  <td class="py-4 pl-4 text-sm text-muted">
                    {{ formatRelativeActivity(job.updatedAt, now) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="py-5 text-sm text-muted">{{ section.empty }}</p>
        </UCard>
      </section>
    </div>
  </main>
</template>
