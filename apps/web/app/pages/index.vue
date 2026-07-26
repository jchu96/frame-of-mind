<script setup lang="ts">
import type { RunPage } from "../../shared/types";

useSeoMeta({
  title: "Runs · Frame of Mind",
  description: "Browse locally indexed Frame of Mind video-understanding runs.",
});

const { data: page, error, refresh, status } = await useFetch<RunPage>("/api/runs", {
  query: { limit: 50 },
  default: () => ({ runs: [] }),
});
const runs = computed(() => page.value.runs);
const loadingMore = ref(false);

const accepted = computed(() => runs.value.reduce((sum, run) => sum + run.acceptedCount, 0));
const meetings = computed(() => new Set(runs.value.map((run) => run.meetingId)).size);

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
        timeZone: "UTC",
      }).format(date);
}
</script>

<template>
  <div>
    <AppHeader />
    <main class="fom-shell py-10 sm:py-14">
      <section class="grid gap-8 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
        <div>
          <p class="fom-kicker text-emerald-700">Review workspace</p>
          <h1 class="mt-4 max-w-3xl text-4xl font-black tracking-[-0.045em] sm:text-6xl">
            Find the signal after the call.
          </h1>
          <p class="mt-5 max-w-2xl text-base leading-7 text-zinc-600 sm:text-lg">
            A private, searchable projection of recipe-driven analyses. The portable run bundle
            stays authoritative; this workspace makes review faster.
          </p>
        </div>
        <div class="grid grid-cols-3 border border-zinc-300 bg-white/80">
          <div class="border-r border-zinc-200 p-4">
            <p class="text-2xl font-black">{{ runs.length }}</p>
            <p class="mt-1 text-xs text-zinc-500">Runs</p>
          </div>
          <div class="border-r border-zinc-200 p-4">
            <p class="text-2xl font-black">{{ meetings }}</p>
            <p class="mt-1 text-xs text-zinc-500">Meetings</p>
          </div>
          <div class="p-4">
            <p class="text-2xl font-black">{{ accepted }}</p>
            <p class="mt-1 text-xs text-zinc-500">Accepted</p>
          </div>
        </div>
      </section>

      <section class="mt-12" aria-labelledby="recent-runs">
        <div class="mb-4 flex items-end justify-between gap-4">
          <div>
            <p class="fom-kicker text-zinc-500">Database projection</p>
            <h2 id="recent-runs" class="mt-2 text-2xl font-black tracking-tight">Recent runs</h2>
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

        <div v-else class="fom-panel overflow-x-auto">
          <table class="w-full min-w-220 text-left text-sm">
            <thead class="border-b border-zinc-200 bg-zinc-50/90 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th class="px-5 py-3 font-semibold">Meeting</th>
                <th class="px-5 py-3 font-semibold">Recipe</th>
                <th class="px-5 py-3 font-semibold">Context</th>
                <th class="px-5 py-3 font-semibold">Results</th>
                <th class="px-5 py-3 font-semibold">Completed (UTC)</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-200">
              <tr v-for="run in runs" :key="run.runId" class="transition-colors hover:bg-emerald-50/50">
                <td class="px-5 py-4">
                  <NuxtLink :to="`/runs/${encodeURIComponent(run.runId)}`" class="font-bold hover:underline">
                    {{ run.meetingTitle || run.meetingId }}
                  </NuxtLink>
                  <p class="mt-1 max-w-80 truncate font-mono text-xs text-zinc-500">{{ run.runId }}</p>
                </td>
                <td class="px-5 py-4">
                  <UBadge color="primary" variant="soft">{{ run.recipeLabel }}</UBadge>
                </td>
                <td class="px-5 py-4 capitalize text-zinc-600">
                  {{ run.provider }} · {{ run.transport }}
                </td>
                <td class="px-5 py-4">
                  <span class="font-bold text-emerald-700">{{ run.acceptedCount }}</span>
                  <span class="text-zinc-400"> / </span>
                  <span class="text-zinc-600">{{ run.rejectedCount }} rejected</span>
                </td>
                <td class="px-5 py-4 text-zinc-600">{{ formatDate(run.completedAt) }}</td>
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
