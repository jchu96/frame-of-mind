<script setup lang="ts">
import { loadMediaResumeReceipt } from "../../app/studio/media-upload.js";
import type { HostedMediaView } from "../../../workflows/src/contracts.js";
import { hostedStorage } from "./hosted-adapter";

const { error } = await useFetch("/api/hosted/configuration");
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
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
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="recording">
    <p class="fom-kicker text-primary">Step 3 of 4</p>
    <h1 class="mt-3 text-4xl font-black">Recording receipt</h1>
    <UAlert class="mt-6 max-w-2xl" color="neutral" variant="soft" icon="i-lucide-upload" title="Recording upload is not available yet" description="Hosted Studio can use an existing sealed, principal-bound media receipt. Upload support remains gated for a later phase." />
    <UCard v-if="media" class="mt-6 max-w-2xl" data-hosted-media-ready="true">
      <h2 class="text-xl font-black">Sealed recording is ready</h2>
      <dl class="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt class="text-muted">Type</dt><dd>{{ media.mimeType }}</dd></div>
        <div><dt class="text-muted">Retention</dt><dd>{{ media.retention }}</dd></div>
        <div class="sm:col-span-2"><dt class="text-muted">Expires</dt><dd>{{ media.expiresAt }}</dd></div>
      </dl>
      <UButton class="mt-5" to="/hosted/new/run" label="Continue to run" />
    </UCard>
    <UAlert v-if="unavailable" class="mt-6 max-w-2xl" color="warning" title="Recording receipt unavailable" description="The receipt is missing, expired, or belongs to another principal." />
  </main>
</template>
