<script setup lang="ts">
import type { StoredRun } from "../../../shared/types";

const route = useRoute();
const runId = computed(() => String(route.params.id));
const { data: run, error } = await useFetch<StoredRun>(() => `/api/runs/${encodeURIComponent(runId.value)}`);

if (error.value?.statusCode === 404) {
  throw createError({ statusCode: 404, statusMessage: "Run not found" });
}

useSeoMeta({
  title: () => `${run.value?.meetingTitle || "Run"} · Frame of Mind`,
});

function importanceColor(value?: "high" | "medium" | "low") {
  if (value === "high") return "error";
  if (value === "medium") return "warning";
  return "neutral";
}
</script>

<template>
  <div>
    <AppHeader />
    <main v-if="run" class="fom-shell py-10 sm:py-14">
      <NuxtLink to="/" class="text-sm font-bold text-emerald-700 hover:underline">← All runs</NuxtLink>

      <section class="mt-6 grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <UBadge color="primary" variant="soft">{{ run.recipeLabel }}</UBadge>
            <UBadge color="neutral" variant="outline" class="capitalize">{{ run.provider }} · {{ run.transport }}</UBadge>
          </div>
          <h1 class="mt-4 text-4xl font-black tracking-[-0.045em] sm:text-5xl">
            {{ run.meetingTitle || run.meetingId }}
          </h1>
          <p class="mt-5 max-w-3xl leading-7 text-zinc-600">{{ run.matchNotes }}</p>
        </div>

        <aside class="border border-zinc-300 bg-white/80 p-5 text-sm">
          <p class="fom-kicker text-zinc-500">Provenance</p>
          <dl class="mt-4 space-y-3">
            <div>
              <dt class="text-xs text-zinc-500">Run ID</dt>
              <dd class="mt-1 break-all font-mono text-xs">{{ run.runId }}</dd>
            </div>
            <div>
              <dt class="text-xs text-zinc-500">Model</dt>
              <dd class="mt-1 font-semibold">{{ run.model }}</dd>
            </div>
            <div>
              <dt class="text-xs text-zinc-500">Accepted / rejected</dt>
              <dd class="mt-1 font-semibold">{{ run.acceptedCount }} / {{ run.rejectedCount }}</dd>
            </div>
            <div v-if="run.importedBy">
              <dt class="text-xs text-zinc-500">Imported by</dt>
              <dd class="mt-1 break-all font-semibold">{{ run.importedBy }}</dd>
            </div>
          </dl>
        </aside>
      </section>

      <section class="mt-12 space-y-5" aria-labelledby="records">
        <div>
          <p class="fom-kicker text-zinc-500">Recipe output</p>
          <h2 id="records" class="mt-2 text-2xl font-black tracking-tight">Analysis records</h2>
        </div>

        <article
          v-for="(item, index) in run.analysis.items"
          :key="`${item.candidate.start}-${index}`"
          class="fom-panel p-6 sm:p-8"
        >
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :color="item.result.accepted ? 'success' : 'neutral'" variant="soft">
              {{ item.result.accepted ? "Accepted" : "Rejected" }}
            </UBadge>
            <UBadge :color="importanceColor(item.result.importance || item.candidate.importance)" variant="outline">
              {{ item.result.importance || item.candidate.importance }}
            </UBadge>
            <span class="font-mono text-xs text-zinc-500">
              {{ item.result.evidence?.timestamp || item.candidate.start }}
            </span>
          </div>

          <h3 class="mt-4 text-xl font-black tracking-tight">{{ item.result.title }}</h3>
          <p class="mt-3 leading-7 text-zinc-700">{{ item.result.summary }}</p>

          <dl v-if="item.result.details?.length" class="mt-5 grid gap-3 sm:grid-cols-2">
            <div v-for="detail in item.result.details" :key="detail.label" class="border-l-2 border-emerald-300 pl-3">
              <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">{{ detail.label }}</dt>
              <dd class="mt-1 whitespace-pre-wrap text-sm leading-6">{{ detail.value }}</dd>
            </div>
          </dl>

          <div v-if="item.result.evidence?.reporterQuote || item.result.evidence?.verbatimUiText" class="mt-5 border border-zinc-200 bg-zinc-50 p-4">
            <p class="fom-kicker text-zinc-500">Evidence excerpt</p>
            <blockquote v-if="item.result.evidence.reporterQuote" class="mt-2 text-sm italic leading-6">
              “{{ item.result.evidence.reporterQuote }}”
            </blockquote>
            <p v-if="item.result.evidence.verbatimUiText" class="mt-2 font-mono text-xs leading-6">
              {{ item.result.evidence.verbatimUiText }}
            </p>
          </div>

          <ol v-if="item.result.steps?.length" class="mt-5 list-decimal space-y-2 pl-5 text-sm leading-6">
            <li v-for="step in item.result.steps" :key="step">{{ step }}</li>
          </ol>

          <p v-if="item.screenshot" class="mt-5 text-xs text-zinc-500">
            Screenshot <code>{{ item.screenshot }}</code> remains in the local run bundle and is not stored in SQLite/D1.
          </p>
          <p v-if="item.result.confidenceNotes" class="mt-4 text-xs leading-5 text-zinc-500">
            Confidence: {{ item.result.confidenceNotes }}
          </p>
        </article>
      </section>
    </main>
  </div>
</template>
