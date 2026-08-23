<script setup lang="ts">
import type { AnalysisItem } from "../../../../src/domain/types.js";
import type { StoredRun } from "../../shared/types.js";
import type { HostedEvidenceView } from "../evidence/service.js";
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

interface HostedEvidenceResponse {
  source: {
    manifestSha256: string;
    recordingSha256: string;
    keptUntil: string;
  };
  evidence: HostedEvidenceView[];
}

const route = useRoute();
const runId = computed(() => String(route.params.runId ?? ""));
const { data: run, error, status } = await useFetch<StoredRun>(
  () => `/api/runs/${encodeURIComponent(runId.value)}`,
);
if (error.value?.statusCode === 404) {
  throw createError({ statusCode: 404, statusMessage: "Run not found" });
}
const { data: evidenceResponse } = await useFetch<HostedEvidenceResponse>(
  () => `/api/hosted/runs/${encodeURIComponent(runId.value)}/evidence`,
);
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
const player = ref<HTMLVideoElement>();
const capturing = ref(false);
const captureCode = ref<string>();
const evidence = ref<HostedEvidenceView[]>([...(evidenceResponse.value?.evidence ?? [])]);
const source = computed(() => evidenceResponse.value?.source);
const mediaAvailable = computed(() => Boolean(source.value));

watch(visibleFindings, (entries) => {
  if (!entries.some((entry) => entry.index === selectedIndex.value)) {
    selectedIndex.value = entries[0]?.index ?? 0;
  }
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date);
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
function seek(timestamp: string): void {
  if (!player.value) return;
  const seconds = timestamp
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
  if (Number.isFinite(seconds)) player.value.currentTime = seconds;
}
async function captureFrame(): Promise<void> {
  captureCode.value = undefined;
  const video = player.value;
  if (!video || !source.value || video.readyState < 2) {
    captureCode.value = "capture_media_unavailable";
    return;
  }
  capturing.value = true;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || canvas.width < 1 || canvas.height < 1) {
      captureCode.value = "capture_canvas_unavailable";
      return;
    }
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      captureCode.value = "capture_frame_blocked";
      return;
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) {
      captureCode.value = "capture_encoding_failed";
      return;
    }
    const response = await fetch(
      `/api/hosted/runs/${encodeURIComponent(runId.value)}/evidence?timestampSeconds=${encodeURIComponent(video.currentTime)}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "image/png",
          "x-fom-source-manifest-sha256": source.value.manifestSha256,
          "x-fom-source-recording-sha256": source.value.recordingSha256,
        },
        body: blob,
      },
    );
    const body = await response.json().catch(() => undefined) as
      | { evidence?: HostedEvidenceView; data?: { code?: string } }
      | undefined;
    if (!response.ok || !body?.evidence) {
      captureCode.value = sanitizeCode(body?.data?.code);
      return;
    }
    evidence.value.push(body.evidence);
  } catch {
    captureCode.value = "capture_request_failed";
  } finally {
    capturing.value = false;
  }
}
function sanitizeCode(code: unknown): string {
  return typeof code === "string" && /^[a-z0-9_:-]{1,120}$/.test(code)
    ? code
    : "capture_request_failed";
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
      <NuxtLink :to="`/runs/${encodeURIComponent(run.runId)}`" class="text-sm font-bold text-primary">← Back to published output</NuxtLink>
      <section class="mt-6 flex flex-wrap items-start justify-between gap-5">
        <div>
          <p class="fom-kicker text-primary">Review workspace</p>
          <h1 class="mt-3 text-4xl font-black tracking-tight sm:text-5xl">{{ title(run) }}</h1>
          <p class="mt-3 max-w-3xl text-muted">Use this timestamped evidence workspace to inspect each finding before using it in follow-up work.</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton color="neutral" variant="outline" icon="i-lucide-copy" label="Copy Markdown" @click="copyMarkdown" />
          <UButton color="neutral" variant="outline" icon="i-lucide-download" label="Download analysis files" @click="downloadBundle" />
        </div>
        <p v-if="exportMessage" class="w-full text-sm text-muted" role="status">{{ exportMessage }}</p>
      </section>

      <UAlert
        v-if="!mediaAvailable"
        class="mt-6"
        color="warning"
        variant="soft"
        icon="i-lucide-video-off"
        title="Playback and screenshots unavailable"
        description="This run has no retained recording for playback or frame capture. Choose retained media for a future run, or reattach the exact recording digest when that flow is available."
        data-hosted-ephemeral-disclosure
      />

      <section v-else class="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]" data-hosted-evidence-panel>
        <UCard>
          <video
            ref="player"
            controls
            preload="metadata"
            crossorigin="use-credentials"
            class="aspect-video w-full bg-black"
            :src="`/api/hosted/runs/${encodeURIComponent(runId)}/media`"
          />
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <UButton icon="i-lucide-camera" :loading="capturing" @click="captureFrame">Capture current frame</UButton>
            <p class="text-sm text-muted">Private media kept until {{ formatDate(source!.keptUntil) }}.</p>
          </div>
          <p v-if="captureCode" class="mt-3 font-mono text-sm text-error" role="alert">{{ captureCode }}</p>
        </UCard>
        <UCard>
          <template #header><h2 class="font-black">Captured evidence</h2></template>
          <p v-if="!evidence.length" class="text-sm text-muted">No captured frames yet.</p>
          <ol v-else class="space-y-3">
            <li v-for="item in evidence" :key="item.id" class="border-b border-default pb-3 text-sm">
              <p class="font-semibold">{{ item.timestampSeconds.toFixed(3) }}s</p>
              <p class="mt-1 break-all font-mono text-xs text-muted">{{ item.captureSha256 }}</p>
            </li>
          </ol>
        </UCard>
      </section>

      <section class="mt-8 grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]" data-review-workspace-grid="true">
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
            <UButton
              v-if="mediaAvailable"
              class="ml-auto"
              size="sm"
              variant="soft"
              icon="i-lucide-play"
              @click="seek(selected.result.evidence?.timestamp || selected.candidate.start)"
            >
              Seek to evidence
            </UButton>
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
