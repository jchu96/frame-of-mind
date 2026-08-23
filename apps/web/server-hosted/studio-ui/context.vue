<script setup lang="ts">
import { commitVideoOnlyContextDraft, loadContextDraft } from "../../app/studio/context-composer.js";
import { hostedStorage } from "./hosted-adapter";
import HostedComposerStepper from "./composer-stepper.vue";

const { error } = await useFetch("/api/hosted/configuration");
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
const saved = ref(false);
onMounted(() => {
  saved.value = loadContextDraft(hostedStorage(sessionStorage)).draft?.mode === "video-only";
});
function save(): void {
  saved.value = commitVideoOnlyContextDraft(hostedStorage(sessionStorage));
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="context">
    <HostedComposerStepper current="context" :intent-ready="true" :recording-ready="false" />
    <p class="fom-kicker text-primary">Step 2 of 4</p>
    <h1 class="mt-3 text-4xl font-black">Choose context</h1>
    <UCard class="mt-8 max-w-2xl">
      <h2 class="text-xl font-black">Video-only analysis</h2>
      <p class="mt-2 text-muted">Use only the recording. Meeting-provider and local-file context are not available in hosted Studio yet.</p>
      <UButton class="mt-5" :label="saved ? 'Video-only saved' : 'Use video only'" icon="i-lucide-check" @click="save" />
    </UCard>
    <UButton v-if="saved" class="mt-6" to="/hosted/new/recording" color="neutral" variant="outline" label="Continue to recording" />
  </main>
</template>
