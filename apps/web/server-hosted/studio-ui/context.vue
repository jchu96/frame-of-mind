<script setup lang="ts">
import { commitVideoOnlyContextDraft } from "../../app/studio/context-composer.js";
import { loadIntentDraft } from "../../app/studio/intent-composer.js";
import { hostedStorage } from "./hosted-adapter";
import HostedComposerStepper from "./composer-stepper.vue";

const { error } = await useFetch("/api/hosted/configuration");
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
const saved = ref(false);
const intentReady = ref(false);
useSeoMeta({
  title: "Sources · Frame of Mind",
  description: "Review which sources the hosted analysis will use.",
});
onMounted(() => {
  intentReady.value = Boolean(loadIntentDraft(hostedStorage(sessionStorage)).draft);
  saved.value = commitVideoOnlyContextDraft(hostedStorage(sessionStorage));
});
function save(): void {
  saved.value = commitVideoOnlyContextDraft(hostedStorage(sessionStorage));
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="context">
    <HostedComposerStepper current="context" :intent-ready="intentReady" :recording-ready="false" />
    <h1 class="text-4xl font-black">Sources</h1>
    <UCard class="mt-8 max-w-2xl">
      <h2 class="text-xl font-black">Recording only</h2>
      <p class="mt-2 text-muted">Hosted analysis uses the recording only. Transcript and meeting-notes sources are coming later.</p>
    </UCard>
    <UButton v-if="saved" class="mt-6" to="/hosted/new/recording" label="Continue" trailing-icon="i-lucide-arrow-right" />
  </main>
</template>
