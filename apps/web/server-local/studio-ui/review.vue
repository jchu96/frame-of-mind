<script setup lang="ts">
import type { StoredRun } from "../../shared/types";
import type { AnalysisItem } from "../../../../src/domain/types";
import {
  filterReviewFindings,
  reviewMarkerPosition,
  reviewTimelineSeconds,
  type ReviewFindingFilter,
} from "./review-filters";

useSeoMeta({
  title: "Review findings · Frame of Mind",
  description: "Review private local findings beside retained recording evidence.",
});

const route = useRoute();
const runId = computed(() => Array.isArray(route.params.runId)
  ? route.params.runId[0] ?? ""
  : String(route.params.runId ?? "")
);
const { data: run, error, status } = await useFetch<StoredRun>(
  () => `/api/runs/${encodeURIComponent(runId.value)}`,
);

if (error.value?.statusCode === 404) {
  throw createError({ statusCode: 404, statusMessage: "Run not found" });
}

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
const acceptedCount = computed(() => findings.value.filter((item) => item.result.accepted).length);
const rejectedCount = computed(() => findings.value.length - acceptedCount.value);
const fallbackTimelineSeconds = computed(() => reviewTimelineSeconds(findings.value));
const videoDuration = ref(0);
const markerDuration = computed(() => videoDuration.value > 0
  ? videoDuration.value
  : fallbackTimelineSeconds.value
);

watch(visibleFindings, (entries) => {
  if (!entries.some((entry) => entry.index === selectedIndex.value)) {
    selectedIndex.value = entries[0]?.index ?? 0;
  }
});

type MediaState = "checking" | "available" | "unavailable";
const mediaState = ref<MediaState>("checking");
const mediaUrl = computed(() => `/api/runs/${encodeURIComponent(runId.value)}/media`);

async function checkRetainedMedia(): Promise<void> {
  mediaState.value = "checking";
  try {
    const response = await $fetch<{ available: boolean }>(
      `/api/runs/${encodeURIComponent(runId.value)}/media-status`,
    );
    mediaState.value = response.available ? "available" : "unavailable";
  } catch {
    mediaState.value = "unavailable";
  }
}

onMounted(() => {
  void checkRetainedMedia();
});

function runTitle(value: StoredRun): string {
  return value.schemaVersion === 2
    ? value.meetingTitle || value.meetingId
    : "Video analysis";
}

function dispositionLabel(item: AnalysisItem): string {
  return item.result.accepted ? "Accepted" : "Rejected";
}

function importance(item: AnalysisItem): "high" | "medium" | "low" {
  return item.result.importance ?? item.candidate.importance;
}

function importanceColor(value: "high" | "medium" | "low") {
  if (value === "high") return "error";
  if (value === "medium") return "warning";
  return "neutral";
}

function selectFinding(index: number): void {
  selectedIndex.value = index;
}

function markerLabel(item: AnalysisItem, index: number): string {
  return `${dispositionLabel(item)} candidate ${index + 1}: ${item.result.title} at ${item.candidate.start}`;
}

function readVideoDuration(event: Event): void {
  const duration = (event.currentTarget as HTMLVideoElement).duration;
  videoDuration.value = Number.isFinite(duration) && duration > 0 ? duration : 0;
}
</script>

<template>
  <main class="fom-shell py-8 sm:py-10" data-studio-review="local">
    <div v-if="status === 'pending'" class="flex items-center gap-3 text-sm text-muted" role="status">
      <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" aria-hidden="true" />
      Loading the review workspace…
    </div>

    <UAlert
      v-else-if="error || !run"
      color="error"
      variant="soft"
      title="Could not load this run"
      description="Return to Activity and choose a completed local run."
      :actions="[{ label: 'Open Activity', to: '/activity' }]"
    />

    <template v-else>
      <section class="flex flex-wrap items-start justify-between gap-5">
        <div class="min-w-0">
          <p class="fom-kicker text-primary">Review workspace</p>
          <h1 class="mt-3 break-words text-4xl font-black tracking-[-0.045em] sm:text-5xl">
            {{ runTitle(run) }}
          </h1>
          <p class="mt-3 max-w-3xl leading-7 text-muted">{{ run.matchNotes }}</p>
        </div>
        <div class="flex flex-wrap gap-2" aria-label="Finding totals">
          <UBadge color="success" variant="soft">{{ acceptedCount }} accepted</UBadge>
          <UBadge color="neutral" variant="soft">{{ rejectedCount }} rejected</UBadge>
        </div>
      </section>

      <section class="mt-8 grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)_22rem]">
        <UCard class="min-w-0" :ui="{ body: 'p-0 sm:p-0' }">
          <template #header>
            <div>
              <p class="fom-kicker text-muted">Findings</p>
              <h2 class="mt-2 text-xl font-black">Analysis records</h2>
            </div>
          </template>

          <fieldset class="border-b border-default p-4">
            <legend class="sr-only">Filter findings by disposition</legend>
            <div class="grid grid-cols-3 gap-2">
              <UButton
                v-for="option in filters"
                :key="option.value"
                type="button"
                color="neutral"
                :variant="filter === option.value ? 'solid' : 'outline'"
                size="sm"
                block
                :aria-pressed="filter === option.value"
                @click="filter = option.value"
              >
                {{ option.label }}
              </UButton>
            </div>
          </fieldset>

          <div v-if="visibleFindings.length" class="max-h-[34rem] overflow-y-auto p-2">
            <button
              v-for="entry in visibleFindings"
              :key="`${entry.item.candidate.start}-${entry.index}`"
              type="button"
              class="w-full rounded-md p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              :class="selectedIndex === entry.index ? 'bg-elevated' : 'hover:bg-elevated/60'"
              :aria-current="selectedIndex === entry.index ? 'true' : undefined"
              @click="selectFinding(entry.index)"
            >
              <span class="flex items-center justify-between gap-3">
                <UBadge
                  :color="entry.item.result.accepted ? 'success' : 'neutral'"
                  variant="soft"
                  size="sm"
                >
                  {{ dispositionLabel(entry.item) }}
                </UBadge>
                <span class="font-mono text-xs text-muted">{{ entry.item.candidate.start }}</span>
              </span>
              <span class="mt-2 block text-sm font-bold text-highlighted">
                {{ entry.item.result.title }}
              </span>
              <span class="mt-1 line-clamp-2 block text-xs leading-5 text-muted">
                {{ entry.item.result.summary }}
              </span>
            </button>
          </div>
          <p v-else class="p-5 text-sm text-muted" role="status">
            No {{ filter === "all" ? "" : filter }} findings in this run.
          </p>
        </UCard>

        <div class="min-w-0 space-y-4">
          <UCard :ui="{ body: 'p-0 sm:p-0' }">
            <div
              v-if="mediaState === 'checking'"
              class="grid aspect-video place-items-center bg-muted text-sm text-muted"
              role="status"
            >
              Checking retained recording…
            </div>
            <div
              v-else-if="mediaState === 'unavailable'"
              class="grid aspect-video place-items-center bg-muted p-8 text-center"
              data-review-playback="unavailable"
            >
              <div>
                <UIcon name="i-lucide-video-off" class="mx-auto size-10 text-muted" aria-hidden="true" />
                <h2 class="mt-4 text-xl font-black">Recording is not available</h2>
                <p class="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
                  This run used ephemeral media, or its retained copy expired or was deleted.
                </p>
                <UButton
                  class="mt-5"
                  type="button"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-paperclip"
                  label="Reattach recording (coming in Task 8.4)"
                  disabled
                />
              </div>
            </div>
            <video
              v-else
              :src="mediaUrl"
              controls
              preload="metadata"
              class="aspect-video w-full bg-black"
              aria-label="Retained recording"
              data-review-playback="available"
              @loadedmetadata="readVideoDuration"
            >
              Your browser cannot play this retained recording.
            </video>
          </UCard>

          <UCard aria-labelledby="candidate-markers-heading">
            <template #header>
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p class="fom-kicker text-muted">Timeline</p>
                  <h2 id="candidate-markers-heading" class="mt-2 text-xl font-black">Candidate markers</h2>
                </div>
                <p class="text-xs text-muted">Selection only · seeking lands in Task 8.3</p>
              </div>
            </template>
            <div class="relative h-10" role="group" aria-label="Candidate markers">
              <div class="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accented" />
              <button
                v-for="(item, index) in findings"
                :key="`${item.candidate.start}-marker-${index}`"
                type="button"
                class="absolute top-1/2 h-6 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full outline-offset-4"
                :class="[
                  item.result.accepted ? 'bg-success' : 'bg-neutral',
                  selectedIndex === index ? 'ring-4 ring-primary/30' : undefined,
                ]"
                :style="{ left: `${reviewMarkerPosition(item, markerDuration)}%` }"
                :aria-label="markerLabel(item, index)"
                :aria-pressed="selectedIndex === index"
                @click="selectFinding(index)"
              />
            </div>
          </UCard>
        </div>

        <UCard class="min-w-0" aria-labelledby="finding-detail-heading">
          <template #header>
            <div>
              <p class="fom-kicker text-muted">Selected finding</p>
              <h2 id="finding-detail-heading" class="mt-2 text-xl font-black">Detail</h2>
            </div>
          </template>

          <div v-if="selected" class="space-y-6">
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <UBadge :color="selected.result.accepted ? 'success' : 'neutral'" variant="soft">
                  {{ dispositionLabel(selected) }}
                </UBadge>
                <UBadge :color="importanceColor(importance(selected))" variant="outline">
                  {{ importance(selected) }}
                </UBadge>
                <span class="font-mono text-xs text-muted">
                  {{ selected.result.evidence?.timestamp || selected.candidate.start }}
                </span>
              </div>
              <h3 class="mt-4 text-2xl font-black tracking-tight">{{ selected.result.title }}</h3>
              <p class="mt-3 whitespace-pre-wrap text-sm leading-6 text-default">
                {{ selected.result.summary }}
              </p>
            </div>

            <dl v-if="selected.result.details?.length" class="space-y-4">
              <div v-for="detail in selected.result.details" :key="detail.label">
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">{{ detail.label }}</dt>
                <dd class="mt-1 whitespace-pre-wrap text-sm leading-6">{{ detail.value }}</dd>
              </div>
            </dl>

            <section
              v-if="selected.result.evidence?.reporterQuote || selected.result.evidence?.verbatimUiText"
              aria-labelledby="finding-evidence-heading"
            >
              <h3 id="finding-evidence-heading" class="text-sm font-black">Evidence</h3>
              <blockquote
                v-if="selected.result.evidence.reporterQuote"
                class="mt-2 whitespace-pre-wrap border-l-2 border-primary pl-3 text-sm italic leading-6"
              >
                {{ selected.result.evidence.reporterQuote }}
              </blockquote>
              <p
                v-if="selected.result.evidence.verbatimUiText"
                class="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-5"
              >
                {{ selected.result.evidence.verbatimUiText }}
              </p>
            </section>

            <section v-if="selected.result.steps?.length" aria-labelledby="finding-steps-heading">
              <h3 id="finding-steps-heading" class="text-sm font-black">Observed sequence</h3>
              <ol class="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6">
                <li v-for="step in selected.result.steps" :key="step">{{ step }}</li>
              </ol>
            </section>

            <p v-if="selected.result.confidenceNotes" class="text-xs leading-5 text-muted">
              Confidence: {{ selected.result.confidenceNotes }}
            </p>
          </div>
          <p v-else class="text-sm text-muted">Choose a finding to inspect its evidence.</p>
        </UCard>
      </section>
    </template>
  </main>
</template>
