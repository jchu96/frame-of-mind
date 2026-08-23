<script setup lang="ts">
import type { StoredRun } from "../../shared/types.js";
import type { AnalysisItem } from "../../../../src/domain/types.js";
import {
  filterReviewFindings,
  reviewEvidenceTimestamp,
  type ReviewFindingFilter,
} from "../../server-local/studio-ui/review-filters.js";
import {
  buildReviewBundle,
  buildReviewMarkdown,
  reviewBundleFilename,
} from "../../server-local/studio-ui/review-export.js";

const route = useRoute();
const runId = computed(() => String(route.params.runId ?? ""));
const { data: run, error, status } = await useFetch<StoredRun>(
  () => `/api/runs/${encodeURIComponent(runId.value)}`,
);
if (error.value?.statusCode === 404) {
  throw createError({ statusCode: 404, statusMessage: "Run not found" });
}
useSeoMeta({
  title: () => `${run.value?.recipeLabel || "Review findings"} · Frame of Mind`,
  description: "Review the findings from a private hosted analysis.",
});

const filters: Array<{ value: ReviewFindingFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
];
const filter = ref<ReviewFindingFilter>("all");
const selectedIndex = ref(0);
const findings = computed(() => run.value?.analysis.items ?? []);
const visibleFindings = computed(() => filterReviewFindings(findings.value, filter.value));
const selected = computed(() => findings.value[selectedIndex.value]);
const exportMessage = ref("");

watch(visibleFindings, (entries) => {
  if (!entries.some((entry) => entry.index === selectedIndex.value)) {
    selectedIndex.value = entries[0]?.index ?? 0;
  }
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}
function title(value: StoredRun): string {
  return `${value.recipeLabel} · ${formatDate(value.completedAt)}`;
}
function importance(item: AnalysisItem): "high" | "medium" | "low" {
  return item.result.importance ?? item.candidate.importance;
}
function importanceColor(value: "high" | "medium" | "low") {
  if (value === "high") return "error";
  if (value === "medium") return "warning";
  return "neutral";
}
async function copyMarkdown(): Promise<void> {
  if (!run.value) return;
  await navigator.clipboard.writeText(buildReviewMarkdown(run.value));
  exportMessage.value = "Markdown copied.";
}
function downloadBundle(): void {
  if (!run.value) return;
  const blob = new Blob([JSON.stringify(buildReviewBundle(run.value), null, 2) + "\n"], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = reviewBundleFilename(run.value.runId);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  exportMessage.value = "Analysis files downloaded without the recording.";
}
</script>

<template>
  <main class="fom-shell py-8 sm:py-10" data-studio-review="hosted">
    <div v-if="status === 'pending'" class="flex items-center gap-3 text-sm text-muted" role="status">
      <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
      Loading the review workspace…
    </div>
    <template v-else-if="run">
      <NuxtLink :to="`/runs/${encodeURIComponent(run.runId)}`" class="text-sm font-bold text-primary">← Back to results</NuxtLink>
      <section class="mt-6 flex flex-wrap items-start justify-between gap-5">
        <div>
          <p class="fom-kicker text-primary">Review workspace</p>
          <h1 class="mt-3 text-4xl font-black tracking-tight sm:text-5xl">{{ title(run) }}</h1>
          <p class="mt-3 max-w-3xl text-muted">Review each finding before using it in follow-up work.</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton color="neutral" variant="outline" icon="i-lucide-copy" label="Copy Markdown" @click="copyMarkdown" />
          <UButton color="neutral" variant="outline" icon="i-lucide-download" label="Download analysis files" @click="downloadBundle" />
        </div>
        <p v-if="exportMessage" class="w-full text-sm text-muted" role="status">{{ exportMessage }}</p>
      </section>

      <UAlert class="mt-6" color="neutral" variant="soft" icon="i-lucide-video-off" title="Recording playback is not available here" description="Hosted review keeps the findings and how they were produced, but does not keep a playable copy of the recording." />

      <section class="mt-8 grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <UCard :ui="{ body: 'p-0 sm:p-0' }">
          <template #header><h2 class="text-xl font-black">Findings</h2></template>
          <div class="grid grid-cols-3 gap-2 border-b border-default p-3">
            <UButton v-for="option in filters" :key="option.value" size="sm" block color="neutral" :variant="filter === option.value ? 'solid' : 'outline'" @click="filter = option.value">{{ option.label }}</UButton>
          </div>
          <div class="p-2" role="listbox" aria-label="Analysis findings">
            <button v-for="entry in visibleFindings" :key="entry.index" type="button" role="option" class="w-full rounded-md p-3 text-left hover:bg-elevated" :class="selectedIndex === entry.index ? 'bg-elevated' : ''" :aria-selected="selectedIndex === entry.index" @click="selectedIndex = entry.index">
              <span class="font-bold text-highlighted">{{ entry.item.result.title }}</span>
              <span class="mt-1 block text-xs text-muted">{{ reviewEvidenceTimestamp(entry.item) }}</span>
            </button>
          </div>
        </UCard>

        <UCard v-if="selected" aria-labelledby="hosted-finding-detail">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :color="selected.result.accepted ? 'success' : 'neutral'" variant="soft">{{ selected.result.accepted ? "Accepted" : "Rejected" }}</UBadge>
            <UBadge :color="importanceColor(importance(selected))" variant="outline">{{ importance(selected) }}</UBadge>
            <span class="text-xs text-muted">{{ reviewEvidenceTimestamp(selected) }}</span>
          </div>
          <h2 id="hosted-finding-detail" class="mt-4 text-2xl font-black">{{ selected.result.title }}</h2>
          <p class="mt-3 whitespace-pre-wrap leading-7 text-default">{{ selected.result.summary }}</p>
          <dl v-if="selected.result.details?.length" class="mt-6 grid gap-4 sm:grid-cols-2">
            <div v-for="detail in selected.result.details" :key="detail.label" class="border-l-2 border-primary pl-3">
              <dt class="text-xs font-bold uppercase tracking-wider text-muted">{{ detail.label }}</dt>
              <dd class="mt-1 whitespace-pre-wrap text-sm">{{ detail.value }}</dd>
            </div>
          </dl>
        </UCard>
      </section>
    </template>
  </main>
</template>
