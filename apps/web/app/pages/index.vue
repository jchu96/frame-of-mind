<script setup lang="ts">
import type { RunPage, RunSummary } from "../../shared/types";

const config = useRuntimeConfig();
useSeoMeta({
  title: () => `${config.public.hostedStudioEnabled ? "Results" : "Runs"} · Frame of Mind`,
  description: "Browse your finished Frame of Mind analyses.",
});

const { data: page, error, refresh, status } = await useFetch<RunPage>("/api/runs", {
  query: { limit: 50 },
  default: () => ({ runs: [] }),
});
const runs = computed(() => page.value.runs);
const loadingMore = ref(false);

const accepted = computed(() => runs.value.reduce((sum, run) => sum + run.acceptedCount, 0));
const meetings = computed(() => new Set(
  runs.value.flatMap((run) => run.schemaVersion === 2 ? [run.meetingId] : []),
).size);

function runTitle(run: RunSummary): string {
  return run.schemaVersion === 2
    ? run.meetingTitle || run.meetingId
    : `${run.recipeLabel} · ${formatDate(run.completedAt)}`;
}

function runContext(run: RunSummary): string {
  return run.schemaVersion === 2
    ? `${run.provider} · ${run.transport}`
    : "video only";
}

async function loadMore() {
  if (!page.value.nextCursor || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const next = await $fetch<RunPage>("/api/runs", {
      query: { limit: 50, cursor: page.value.nextCursor },
    });
    page.value = {
      runs: [...page.value.runs, ...next.runs],
      ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}),
    };
  } finally {
    loadingMore.value = false;
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
</script>

<template>
  <div>
    <AppHeader />
    <main class="fom-shell py-10 sm:py-14">
      <section class="grid gap-8 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
        <div>
          <p class="fom-kicker text-primary">Results</p>
          <h1 class="mt-4 max-w-3xl text-4xl font-black tracking-[-0.045em] sm:text-6xl">
            Your finished analyses.
          </h1>
          <p class="mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg">
            Your finished analyses, in one place. Only you can see them.
          </p>
        </div>
        <div class="grid grid-cols-3 border border-default bg-elevated/80">
          <div class="border-r border-default p-4">
            <p class="text-2xl font-black">{{ runs.length }}</p>
            <p class="mt-1 text-xs text-muted">Results</p>
          </div>
          <div class="border-r border-default p-4">
            <p class="text-2xl font-black">{{ meetings }}</p>
            <p class="mt-1 text-xs text-muted">Meetings</p>
          </div>
          <div class="p-4">
            <p class="text-2xl font-black">{{ accepted }}</p>
            <p class="mt-1 text-xs text-muted">Findings</p>
          </div>
        </div>
      </section>

      <section class="mt-12" aria-labelledby="recent-runs">
        <div class="mb-4 flex items-end justify-between gap-4">
          <div>
            <p class="fom-kicker text-muted">Results</p>
            <h2 id="recent-runs" class="mt-2 text-2xl font-black tracking-tight">Recent analyses</h2>
          </div>
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :loading="status === 'pending'"
            @click="refresh()"
          >
            Refresh
          </UButton>
        </div>

        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          title="Could not load runs"
          description="Check the database configuration and server logs."
          class="mb-4"
        />

        <EmptyRuns v-if="!error && runs.length === 0" />

        <div v-else class="space-y-3 sm:hidden">
          <UCard v-for="run in runs" :key="`mobile-${run.runId}`">
            <NuxtLink :to="`/runs/${encodeURIComponent(run.runId)}`" class="text-lg font-black hover:text-primary">
              {{ runTitle(run) }}
            </NuxtLink>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <UBadge color="primary" variant="soft">{{ run.recipeLabel }}</UBadge>
              <span class="text-sm text-muted">Findings: {{ run.acceptedCount }}</span>
            </div>
          </UCard>
        </div>
        <div v-if="runs.length" class="fom-panel hidden overflow-x-auto sm:block">
          <table class="w-full min-w-220 text-left text-sm">
            <thead class="border-b border-default bg-elevated/90 text-xs uppercase tracking-wider text-muted">
              <tr>
                <th class="px-5 py-3 font-semibold">Source</th>
                <th class="px-5 py-3 font-semibold">Recipe</th>
                <th class="px-5 py-3 font-semibold">Context</th>
                <th class="px-5 py-3 font-semibold">Findings</th>
                <th class="px-5 py-3 font-semibold">Completed</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr v-for="run in runs" :key="run.runId" class="transition-colors hover:bg-elevated/60">
                <td class="px-5 py-4">
                  <NuxtLink :to="`/runs/${encodeURIComponent(run.runId)}`" class="font-bold hover:underline">
                    {{ runTitle(run) }}
                  </NuxtLink>
                </td>
                <td class="px-5 py-4">
                  <UBadge color="primary" variant="soft">{{ run.recipeLabel }}</UBadge>
                </td>
                <td class="px-5 py-4 capitalize text-muted">
                  {{ runContext(run) }}
                </td>
                <td class="px-5 py-4">
                  <span class="font-bold text-primary">{{ run.acceptedCount }}</span>
                </td>
                <td class="px-5 py-4 text-muted"><time :datetime="run.completedAt" :title="run.completedAt">{{ formatDate(run.completedAt) }}</time></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="page.nextCursor" class="mt-5 flex justify-center">
          <UButton color="neutral" variant="outline" :loading="loadingMore" @click="loadMore">
            Load more
          </UButton>
        </div>
      </section>
    </main>
  </div>
</template>
