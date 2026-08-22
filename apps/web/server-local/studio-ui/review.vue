<script setup lang="ts">
import type { StoredRun } from "../../shared/types";
import type { AnalysisItem } from "../../../../src/domain/types";
import {
  alignedTranscriptExcerpt,
  filterReviewFindings,
  reviewEvidenceTimestamp,
  reviewMarkerPosition,
  reviewSeekSeconds,
  reviewTimelineSeconds,
  type ReviewFindingFilter,
} from "./review-filters";
import {
  buildReviewBundle,
  buildReviewMarkdown,
  reviewBundleFilename,
} from "./review-export";
import {
  reattachReviewMedia,
  ReviewReattachError,
  type ReviewReattachPhase,
} from "./review-reattach";

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
const player = ref<HTMLVideoElement>();
const selectedTranscript = computed(() => selected.value && run.value
  ? alignedTranscriptExcerpt(selected.value, run.value.manifest)
  : undefined
);

watch(visibleFindings, (entries) => {
  if (!entries.some((entry) => entry.index === selectedIndex.value)) {
    selectedIndex.value = entries[0]?.index ?? 0;
  }
});

type MediaState = "checking" | "available" | "unavailable";
const mediaState = ref<MediaState>("checking");
const mediaUrl = computed(() => `/api/runs/${encodeURIComponent(runId.value)}/media`);
const reattachInput = ref<HTMLInputElement>();
const reattaching = ref(false);
const reattachPhase = ref<ReviewReattachPhase>();
const reattachConfirmedBytes = ref(0);
const reattachError = ref<string>();
const exportMessage = ref<string>();

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
  document.addEventListener("keydown", handlePageShortcut);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handlePageShortcut);
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

function selectFinding(index: number, seek = true): void {
  selectedIndex.value = index;
  if (seek) void nextTick(seekSelectedFinding);
}

function seekSelectedFinding(): void {
  if (!selected.value || mediaState.value !== "available" || !player.value) return;
  try {
    player.value.currentTime = reviewSeekSeconds(selected.value);
  } catch {
    // Some browsers reject seeks until metadata is available; loadedmetadata retries it.
  }
}

function moveVisibleSelection(delta: number): void {
  const current = visibleFindings.value.findIndex(
    (entry) => entry.index === selectedIndex.value,
  );
  if (current < 0 || visibleFindings.value.length === 0) return;
  const nextIndex = Math.min(
    visibleFindings.value.length - 1,
    Math.max(0, current + delta),
  );
  const nextEntry = visibleFindings.value[nextIndex];
  if (!nextEntry) return;
  selectFinding(nextEntry.index);
  void nextTick(() => document.getElementById(`review-finding-${nextEntry.index}`)?.focus());
}

function handleFindingKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveVisibleSelection(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveVisibleSelection(-1);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    seekSelectedFinding();
  }
}

function handlePageShortcut(event: KeyboardEvent): void {
  if (
    event.metaKey || event.ctrlKey || event.altKey
    || ["INPUT", "TEXTAREA", "SELECT", "VIDEO"].includes(
      (event.target as HTMLElement | null)?.tagName ?? "",
    )
  ) return;
  if (event.key.toLowerCase() === "j") {
    event.preventDefault();
    moveVisibleSelection(1);
  } else if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    moveVisibleSelection(-1);
  }
}

function markerLabel(item: AnalysisItem, index: number): string {
  return `${dispositionLabel(item)} candidate ${index + 1}: ${item.result.title} at ${item.candidate.start}`;
}

function readVideoDuration(event: Event): void {
  const duration = (event.currentTarget as HTMLVideoElement).duration;
  videoDuration.value = Number.isFinite(duration) && duration > 0 ? duration : 0;
  seekSelectedFinding();
}

function reattachStatus(): string {
  if (reattachPhase.value === "fingerprinting") return "Binding the selected file in bounded chunks.";
  if (reattachPhase.value === "uploading") {
    return `${reattachConfirmedBytes.value} bytes staged and confirmed by the local server.`;
  }
  if (reattachPhase.value === "verifying") return "Streaming the staged file through SHA-256 verification.";
  if (reattachPhase.value === "binding") return "Binding the verified recording to this run.";
  return "";
}

async function handleReattachSelection(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !run.value || reattaching.value) return;
  reattaching.value = true;
  reattachError.value = undefined;
  reattachConfirmedBytes.value = 0;
  try {
    await reattachReviewMedia({
      runId: run.value.runId,
      expectedSha256: run.value.manifest.recordingSha256,
      file,
      onPhase: (phase) => { reattachPhase.value = phase; },
      onConfirmedBytes: (bytes) => { reattachConfirmedBytes.value = bytes; },
    });
    mediaState.value = "available";
    await nextTick();
    player.value?.load();
  } catch (caught) {
    mediaState.value = "unavailable";
    reattachError.value = caught instanceof ReviewReattachError
      ? caught.message
      : "Studio could not verify and reattach that recording. Try again.";
  } finally {
    reattaching.value = false;
    reattachPhase.value = undefined;
  }
}

async function copyMarkdown(): Promise<void> {
  if (!run.value) return;
  exportMessage.value = undefined;
  const markdown = buildReviewMarkdown(run.value);
  try {
    await navigator.clipboard.writeText(markdown);
    exportMessage.value = "Markdown copied.";
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = markdown;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    exportMessage.value = copied
      ? "Markdown copied."
      : "Clipboard access was denied. Use the download instead.";
  }
}

function downloadBundle(): void {
  if (!run.value) return;
  const blob = new Blob(
    [JSON.stringify(buildReviewBundle(run.value), null, 2) + "\n"],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = reviewBundleFilename(run.value.runId);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  exportMessage.value = "Run bundle downloaded without recording media.";
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

      <section class="mt-5 flex flex-wrap items-center gap-3" aria-label="Run exports">
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          icon="i-lucide-copy"
          label="Copy Markdown"
          @click="copyMarkdown"
        />
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          icon="i-lucide-download"
          label="Download run bundle"
          @click="downloadBundle"
        />
        <p class="text-xs text-muted">Local export only · no GitHub, Asana, or external publishing.</p>
        <p v-if="exportMessage" class="w-full text-sm text-muted" role="status">{{ exportMessage }}</p>
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

          <div
            v-if="visibleFindings.length"
            class="max-h-[34rem] overflow-y-auto p-2"
            role="listbox"
            aria-label="Analysis findings"
            :aria-activedescendant="`review-finding-${selectedIndex}`"
            @keydown="handleFindingKeydown"
          >
            <button
              v-for="entry in visibleFindings"
              :key="`${entry.item.candidate.start}-${entry.index}`"
              type="button"
              role="option"
              :id="`review-finding-${entry.index}`"
              class="w-full rounded-md p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              :class="selectedIndex === entry.index ? 'bg-elevated' : 'hover:bg-elevated/60'"
              :aria-selected="selectedIndex === entry.index"
              :tabindex="selectedIndex === entry.index ? 0 : -1"
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
                <input
                  ref="reattachInput"
                  class="sr-only"
                  type="file"
                  accept=".mp4,.m4v,.mov,.webm,video/mp4,video/quicktime,video/webm"
                  aria-label="Choose original recording"
                  :disabled="reattaching"
                  @change="handleReattachSelection"
                >
                <UButton
                  class="mt-5"
                  type="button"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-paperclip"
                  label="Reattach original recording"
                  :loading="reattaching"
                  :disabled="reattaching"
                  @click="reattachInput?.click()"
                />
                <p v-if="reattaching" class="mt-3 text-sm text-muted" role="status">
                  {{ reattachStatus() }}
                </p>
                <UAlert
                  v-if="reattachError"
                  class="mt-4 text-left"
                  color="error"
                  variant="soft"
                  title="Recording was not reattached"
                  :description="reattachError"
                />
              </div>
            </div>
            <video
              v-else
              ref="player"
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
                <p class="text-xs text-muted">Click a marker to seek · J/K moves between findings</p>
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
                  {{ reviewEvidenceTimestamp(selected) }}
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
              v-if="selected.result.evidence?.verbatimUiText"
              aria-labelledby="finding-evidence-heading"
            >
              <h3 id="finding-evidence-heading" class="text-sm font-black">Evidence</h3>
              <p
                class="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-5"
              >
                {{ selected.result.evidence.verbatimUiText }}
              </p>
            </section>

            <section v-if="selectedTranscript" aria-labelledby="aligned-transcript-heading">
              <h3 id="aligned-transcript-heading" class="text-sm font-black">Aligned transcript excerpt</h3>
              <p class="mt-1 text-xs text-muted">
                Video {{ selectedTranscript.videoTimestamp }}
                <template v-if="selectedTranscript.transcriptTimestamp">
                  · Transcript {{ selectedTranscript.transcriptTimestamp }}
                  ({{ selectedTranscript.offsetSeconds! >= 0 ? '+' : '' }}{{ selectedTranscript.offsetSeconds }}s)
                </template>
                <template v-else-if="selectedTranscript.offsetSeconds !== undefined">
                  · Before the aligned transcript begins ({{ selectedTranscript.offsetSeconds }}s)
                </template>
              </p>
              <blockquote class="mt-2 whitespace-pre-wrap border-l-2 border-primary pl-3 text-sm italic leading-6">
                {{ selectedTranscript.text }}
              </blockquote>
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
