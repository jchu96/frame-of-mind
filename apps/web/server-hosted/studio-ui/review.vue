<script setup lang="ts">
import type { StoredRun } from "../../shared/types.js";
import type { HostedEvidenceView } from "../evidence/service.js";

const route = useRoute();
const runId = computed(() => String(route.params.runId));
const { data: run, error: runError } = await useFetch<StoredRun>(
  () => `/api/runs/${encodeURIComponent(runId.value)}`,
  { headers: useRequestHeaders(["cookie"]) },
);
const player = ref<HTMLVideoElement>();
const capturing = ref(false);
const captureCode = ref<string>();
const evidence = ref<HostedEvidenceView[]>([]);
const source = ref<{ manifestSha256: string; recordingSha256: string; keptUntil: string }>();
const mediaAvailable = ref(false);

async function loadEvidence(): Promise<void> {
  try {
    const response = await $fetch<{
      source: NonNullable<typeof source.value>;
      evidence: HostedEvidenceView[];
    }>(`/api/hosted/runs/${encodeURIComponent(runId.value)}/evidence`);
    source.value = response.source;
    evidence.value = response.evidence;
    mediaAvailable.value = true;
  } catch {
    source.value = undefined;
    mediaAvailable.value = false;
  }
}

onMounted(() => void loadEvidence());

function seek(timestamp: string): void {
  if (!player.value) return;
  const seconds = timestamp.split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
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
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
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
</script>

<template>
  <main class="fom-shell py-8" data-hosted-review>
    <UAlert v-if="runError || !run" color="error" title="Could not load this run" description="Return to Hosted Activity and choose a completed run." />
    <template v-else>
      <header><p class="fom-kicker text-primary">Review workspace</p><h1 class="mt-3 text-4xl font-black">{{ run.recipeLabel }}</h1><p class="mt-3 text-muted">{{ run.matchNotes }}</p></header>
      <UAlert v-if="!mediaAvailable" class="mt-6" color="warning" variant="soft" title="Playback and screenshots unavailable" description="An ephemeral run has no playback or frame capture after the upload tab closes. Choose retained media for a future run, or reattach the exact recording digest when that flow is available." data-hosted-ephemeral-disclosure />
      <section v-else class="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <UCard>
          <video ref="player" controls preload="metadata" crossorigin="use-credentials" class="aspect-video w-full bg-black" :src="`/api/hosted/runs/${encodeURIComponent(runId)}/media`" />
          <div class="mt-4 flex flex-wrap items-center gap-3"><UButton icon="i-lucide-camera" :loading="capturing" @click="captureFrame">Capture current frame</UButton><p class="text-sm text-muted">Private media kept until {{ new Date(source!.keptUntil).toLocaleString() }}.</p></div>
          <p v-if="captureCode" class="mt-3 font-mono text-sm text-error" role="alert">{{ captureCode }}</p>
        </UCard>
        <UCard><template #header><h2 class="font-black">Captured evidence</h2></template><p v-if="!evidence.length" class="text-sm text-muted">No captured frames yet.</p><ol v-else class="space-y-3"><li v-for="item in evidence" :key="item.id" class="border-b border-default pb-3 text-sm"><p class="font-semibold">{{ item.timestampSeconds.toFixed(3) }}s</p><p class="mt-1 break-all font-mono text-xs text-muted">{{ item.captureSha256 }}</p></li></ol></UCard>
      </section>
      <section class="mt-8 space-y-4"><article v-for="(item, index) in run.analysis.items" :key="index" class="fom-panel p-5"><div class="flex flex-wrap items-center justify-between gap-3"><h2 class="font-black">{{ item.result.title }}</h2><UButton v-if="mediaAvailable" size="sm" variant="soft" @click="seek(item.result.evidence?.timestamp || item.candidate.start)">Seek to evidence</UButton></div><p class="mt-2 text-sm text-muted">{{ item.result.summary }}</p></article></section>
    </template>
  </main>
</template>
