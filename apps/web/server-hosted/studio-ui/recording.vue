<script setup lang="ts">
import { loadMediaResumeReceipt } from "../../app/studio/media-upload.js";
import { loadIntentDraft } from "../../app/studio/intent-composer.js";
import type { HostedMediaView } from "../../../workflows/src/contracts.js";
import { hostedStorage } from "./hosted-adapter";
import HostedComposerStepper from "./composer-stepper.vue";

const { error } = await useFetch("/api/hosted/configuration");
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
useSeoMeta({
  title: "Add a recording · Frame of Mind",
  description: "Add the recording for a hosted analysis.",
});
const route = useRoute();
const media = ref<HostedMediaView>();
const intentReady = ref(false);
const unavailable = ref(false);
onMounted(async () => {
  intentReady.value = Boolean(loadIntentDraft(hostedStorage(sessionStorage)).draft);
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
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="recording">
    <HostedComposerStepper current="recording" :intent-ready="intentReady" :recording-ready="Boolean(media)" />
    <UAlert v-if="typeof route.query.reason === 'string'" class="mb-6" color="warning" variant="soft" :description="route.query.reason" />
    <h1 class="text-4xl font-black">Add your recording</h1>
    <UAlert class="mt-6 max-w-2xl" color="warning" variant="soft" icon="i-lucide-upload" title="Recording upload is not available yet" description="Uploading a recording here isn't available yet. For now, run this analysis from the desktop Studio." />
    <div v-if="!media" class="mt-4 flex max-w-2xl flex-wrap items-center gap-3">
      <UButton to="/hosted/activity" label="Back to Activity" color="neutral" variant="outline" icon="i-lucide-arrow-left" />
      <UButton to="https://github.com/jchu96/frame-of-mind#launch-the-local-studio" target="_blank" label="How to run this on the desktop Studio" color="neutral" variant="link" trailing-icon="i-lucide-external-link" />
    </div>
    <UCard v-if="media" class="mt-6 max-w-2xl" data-hosted-media-ready="true">
      <h2 class="text-xl font-black">Recording ready</h2>
      <p class="mt-2 text-muted">
        Uploaded <time :datetime="media.sealedAt" :title="media.sealedAt">{{ formatDate(media.sealedAt) }}</time>
        · <template v-if="media.retention === 'ephemeral'">deleted after analysis</template><template v-else>kept until <time :datetime="media.expiresAt" :title="media.expiresAt">{{ formatDate(media.expiresAt) }}</time></template>
      </p>
      <UButton class="mt-5" to="/hosted/new/run" label="Continue" trailing-icon="i-lucide-arrow-right" />
    </UCard>
    <UAlert v-if="unavailable" class="mt-6 max-w-2xl" color="warning" title="Recording unavailable" description="This recording is missing, expired, or belongs to another account." />
  </main>
</template>
