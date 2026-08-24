<script setup lang="ts">
import type { StoredRun } from "../../../shared/types";

const route = useRoute();
const runId = computed(() => String(route.params.id));
const { data: run, error } = await useFetch<StoredRun>(() => `/api/runs/${encodeURIComponent(runId.value)}`);

if (error.value?.statusCode === 404) {
  throw createError({ statusCode: 404, statusMessage: "Run not found" });
}

useSeoMeta({
  title: () => `${run.value
    ? runTitle(run.value)
    : "Run"} · Frame of Mind`,
});

function runTitle(value: StoredRun): string {
  return value.schemaVersion === 2
    ? value.meetingTitle || value.meetingId
    : `${value.recipeLabel} · ${formatDate(value.completedAt)}`;
}

function runContext(value: StoredRun): string {
  return value.schemaVersion === 2
    ? `${value.provider} · ${value.transport}`
    : "recording only";
}

function importanceColor(value?: "high" | "medium" | "low") {
  if (value === "high") return "error";
  if (value === "medium") return "warning";
  return "neutral";
}
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}
function hostedAttemptId(value: StoredRun): string | undefined {
  return value.runId.startsWith("hosted_attempt_")
    ? value.runId.slice("hosted_".length)
    : undefined;
}
</script>

<template>
  <div>
    <AppHeader />
    <main v-if="error" class="fom-shell py-10 sm:py-14">
      <UAlert
        color="error"
        variant="soft"
        title="Could not load this run"
        description="The results could not be loaded. Try again, or ask the workspace owner for help."
      />
      <UButton to="/" color="neutral" variant="ghost" class="mt-4">Return to all runs</UButton>
    </main>
    <main v-else-if="run" class="fom-shell py-10 sm:py-14">
      <NuxtLink
        :to="hostedAttemptId(run) ? `/hosted/activity/${encodeURIComponent(hostedAttemptId(run)!)}` : '/'"
        class="text-sm font-bold text-primary hover:underline"
      >
        {{ hostedAttemptId(run) ? "← Back to activity" : "← All analyses" }}
      </NuxtLink>

      <section class="mt-6 grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <UBadge color="primary" variant="soft">{{ run.recipeLabel }}</UBadge>
            <UBadge color="neutral" variant="outline" class="capitalize">{{ runContext(run) }}</UBadge>
          </div>
          <h1 class="mt-4 text-4xl font-black tracking-[-0.045em] sm:text-5xl">
            {{ runTitle(run) }}
          </h1>
          <p class="mt-5 max-w-3xl leading-7 text-muted">{{ run.matchNotes }}</p>
          <p class="mt-3 max-w-3xl text-sm text-muted">This is the published output. Open the review workspace to inspect timestamped evidence finding by finding.</p>
          <UButton class="mt-5" :to="`/review/${encodeURIComponent(run.runId)}`" color="neutral" variant="outline" label="Review findings" icon="i-lucide-scan-search" />
        </div>

        <aside class="border border-default bg-elevated/80 p-5 text-sm">
          <p class="fom-kicker text-muted">About this run</p>
          <dl class="mt-4 space-y-3">
            <div>
              <dt class="text-xs text-muted">Analysis provider</dt>
              <dd class="mt-1 font-semibold">Analysed with Gemini</dd>
            </div>
            <div>
              <dt class="text-xs text-muted">Findings</dt>
              <dd class="mt-1 font-semibold">{{ run.acceptedCount }} accepted</dd>
            </div>
            <div v-if="run.importedBy">
              <dt class="text-xs text-muted">Imported by</dt>
              <dd class="mt-1 break-all font-semibold">{{ run.importedBy }}</dd>
            </div>
          </dl>
        </aside>
      </section>

      <section class="mt-12 space-y-5" aria-labelledby="records">
        <div>
          <p class="fom-kicker text-muted">Findings</p>
          <h2 id="records" class="mt-2 text-2xl font-black tracking-tight">Analysis findings</h2>
        </div>

        <article
          v-for="(item, index) in run.analysis.items"
          :key="`${item.candidate.start}-${index}`"
          class="fom-panel p-6 sm:p-8"
        >
          <div class="flex flex-wrap items-center gap-2">
            <UBadge
              data-run-finding-verdict
              :data-semantic-color="item.result.accepted ? 'success' : 'neutral'"
              :color="item.result.accepted ? 'success' : 'neutral'"
              variant="soft"
            >
              {{ item.result.accepted ? "Accepted" : "Rejected" }}
            </UBadge>
            <UBadge
              data-run-finding-severity
              :data-semantic-color="importanceColor(item.result.importance || item.candidate.importance)"
              :color="importanceColor(item.result.importance || item.candidate.importance)"
              variant="outline"
            >
              {{ item.result.importance || item.candidate.importance }}
            </UBadge>
            <span class="font-mono text-xs text-muted">
              {{ item.result.evidence?.timestamp || item.candidate.start }}
            </span>
          </div>

          <h3 data-run-finding-title class="mt-4 text-xl font-black tracking-tight">{{ item.result.title }}</h3>
          <p data-run-finding-summary class="mt-3 leading-7 text-default">{{ item.result.summary }}</p>

          <dl v-if="item.result.details?.length" class="mt-5 grid gap-3 sm:grid-cols-2">
            <div v-for="detail in item.result.details" :key="detail.label" class="border-l-2 border-primary pl-3">
              <dt class="text-xs font-bold uppercase tracking-wider text-muted">{{ detail.label }}</dt>
              <dd data-run-finding-value class="mt-1 whitespace-pre-wrap text-sm leading-6">{{ detail.value }}</dd>
            </div>
          </dl>

          <div v-if="item.result.evidence?.reporterQuote || item.result.evidence?.verbatimUiText" data-run-finding-evidence class="mt-5 border border-default bg-elevated p-4">
            <p class="fom-kicker text-muted">Evidence excerpt</p>
            <blockquote v-if="item.result.evidence.reporterQuote" class="mt-2 text-sm italic leading-6">
              “{{ item.result.evidence.reporterQuote }}”
            </blockquote>
            <p v-if="item.result.evidence.verbatimUiText" class="mt-2 font-mono text-xs leading-6">
              {{ item.result.evidence.verbatimUiText }}
            </p>
          </div>

          <ol v-if="item.result.steps?.length" class="mt-5 list-decimal space-y-2 pl-5 text-sm leading-6">
            <li v-for="step in item.result.steps" :key="step" data-run-finding-step>{{ step }}</li>
          </ol>

          <p v-if="item.screenshot" class="mt-5 text-xs text-muted">
            Screenshot <code>{{ item.screenshot }}</code> remains in the local run bundle and is not stored in SQLite/D1.
          </p>
          <p v-if="item.result.confidenceNotes" class="mt-4 text-xs leading-5 text-muted">
            Confidence: {{ item.result.confidenceNotes }}
          </p>
        </article>
      </section>
    </main>
  </div>
</template>
