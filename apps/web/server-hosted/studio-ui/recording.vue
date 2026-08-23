<script setup lang="ts">
import { loadMediaResumeReceipt } from "../../app/studio/media-upload.js";
import type { HostedMediaView } from "../../../workflows/src/contracts.js";
import { hostedStorage } from "./hosted-adapter";
import HostedComposerStepper from "./composer-stepper.vue";

const { error } = await useFetch("/api/hosted/configuration");
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
useSeoMeta({
  title: "Add a recording · Frame of Mind",
  description: "Add the recording for a hosted analysis.",
});
const media = ref<HostedMediaView>();
const unavailable = ref(false);
onMounted(async () => {
  const receipt = loadMediaResumeReceipt(hostedStorage(sessionStorage));
  if (!receipt.mediaSessionId) return;
  try {
    const response = await $fetch<{ media: HostedMediaView }>(`/api/hosted/media/${encodeURIComponent(receipt.mediaSessionId)}`);
    media.value = response.media;
  } catch {
    unavailable.value = true;
  }
});
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="recording">
    <HostedComposerStepper current="recording" :intent-ready="true" :recording-ready="Boolean(media)" />
    <p class="fom-kicker text-primary">Recording</p>
    <h1 class="mt-3 text-4xl font-black">Add your recording</h1>
    <UAlert class="mt-6 max-w-2xl" color="warning" variant="soft" icon="i-lucide-upload" title="Recording upload is not available yet" description="Uploading a recording here isn't available yet. For now, run this analysis from the desktop Studio." />
    <div v-if="!media" class="mt-4 max-w-2xl">
      <UButton label="Upload a recording" icon="i-lucide-upload" disabled />
      <p class="mt-2 text-sm text-muted">Coming in the next release.</p>
    </div>
    <UCard v-if="media" class="mt-6 max-w-2xl" data-hosted-media-ready="true">
      <h2 class="text-xl font-black">Recording ready</h2>
      <p class="mt-2 text-muted">
        Uploaded <time :datetime="media.sealedAt" :title="media.sealedAt">{{ formatDate(media.sealedAt) }}</time>
        · kept until <time :datetime="media.expiresAt" :title="media.expiresAt">{{ formatDate(media.expiresAt) }}</time>
      </p>
      <UButton class="mt-5" to="/hosted/new/run" label="Continue" trailing-icon="i-lucide-arrow-right" />
    </UCard>
    <UAlert v-if="unavailable" class="mt-6 max-w-2xl" color="warning" title="Recording unavailable" description="This recording is missing, expired, or belongs to another account." />
  </main>
</template>
