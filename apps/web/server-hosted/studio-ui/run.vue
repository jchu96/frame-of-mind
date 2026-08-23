<script setup lang="ts">
import { clearContextDraft, loadContextDraft } from "../../app/studio/context-composer.js";
import { clearIntentDraft, loadIntentDraft } from "../../app/studio/intent-composer.js";
import { clearMediaResumeReceipt, loadMediaResumeReceipt } from "../../app/studio/media-upload.js";
import {
  buildComposerPayload,
  clearRunDraft,
  createOrLoadRunDraft,
  deriveRunReceiptState,
  retentionRequestForMediaSession,
} from "../../app/studio/run-composer.js";
import { composerReadinessFromStorage } from "../../app/studio/composer-readiness.js";
import type { HostedJobView, HostedMediaView } from "../../../workflows/src/contracts.js";
import { hostedMediaSession, hostedStorage } from "./hosted-adapter";
import HostedComposerStepper from "./composer-stepper.vue";

interface Recipe { id: string; label: string; revision: string }
const { data: catalog, error } = await useFetch<{ recipes: Recipe[] }>("/api/hosted/recipes");
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
const blockers = ref<Array<{ message: string; link: string }>>([]);
const ready = ref(false);
const submitting = ref(false);
const submitError = ref("");
let payload: ReturnType<typeof buildComposerPayload> | undefined;

onMounted(async () => {
  const storage = hostedStorage(sessionStorage);
  const receipt = loadMediaResumeReceipt(storage);
  let media: HostedMediaView | undefined;
  if (receipt.mediaSessionId) {
    try {
      media = (await $fetch<{ media: HostedMediaView }>(`/api/hosted/media/${encodeURIComponent(receipt.mediaSessionId)}`)).media;
    } catch {
      // The shared receipt derivation reports the principal-bound receipt as unavailable.
    }
  }
  const session = media ? hostedMediaSession(media) : undefined;
  const readiness = composerReadinessFromStorage(storage, session);
  const state = deriveRunReceiptState({
    intent: loadIntentDraft(storage),
    context: loadContextDraft(storage),
    mediaSession: session,
    recipes: catalog.value?.recipes,
    readinessCanRun: readiness.canRun,
    now: new Date().toISOString(),
  });
  blockers.value = state.blockers.map((item) => ({
    message: item.message,
    link: `/hosted/new${item.link}`,
  }));
  if (state.intent.blocker) {
    await navigateTo({
      path: "/hosted/new/intent",
      query: { reason: "Complete Intent before opening Run." },
    });
    return;
  }
  if (!state.canSubmit || !session) return;
  const draft = createOrLoadRunDraft(storage, retentionRequestForMediaSession(session), () => `hosted-run:${crypto.randomUUID()}`);
  payload = buildComposerPayload(state, draft);
  ready.value = true;
});

async function start(): Promise<void> {
  if (!payload || submitting.value) return;
  submitting.value = true;
  submitError.value = "";
  try {
    const response = await $fetch<{ job: HostedJobView }>("/api/hosted/composer/jobs", {
      method: "POST",
      body: payload,
    });
    const storage = hostedStorage(sessionStorage);
    clearIntentDraft(storage);
    clearContextDraft(storage);
    clearMediaResumeReceipt(storage);
    clearRunDraft(storage);
    await navigateTo(`/hosted/activity/${encodeURIComponent(response.job.id)}`);
  } catch (caught) {
    const code = (caught as { data?: { data?: { code?: string } } }).data?.data?.code;
    submitError.value = code
      ? `Analysis could not start (${code}). Review the receipt and try again.`
      : "Analysis could not start. Review the receipt and try again.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="run">
    <HostedComposerStepper current="run" :intent-ready="true" :recording-ready="ready" />
    <p class="fom-kicker text-primary">Step 4 of 4</p>
    <h1 class="mt-3 text-4xl font-black">Review and start</h1>
    <UCard class="mt-8 max-w-2xl">
      <h2 class="text-xl font-black">Transfer disclosure</h2>
      <p class="mt-2 text-muted">Starting analysis transfers the sealed recording to Gemini. The immutable recipe, model, media digest, context mode, and cleanup receipt become provenance in the published run.</p>
      <ul v-if="blockers.length" class="mt-5 space-y-3">
        <li v-for="blocker in blockers" :key="blocker.message" class="flex items-center justify-between gap-4">
          <span>{{ blocker.message }}</span><UButton :to="blocker.link" size="xs" color="neutral" variant="outline" label="Review" />
        </li>
      </ul>
      <UButton v-else class="mt-5" data-hosted-run-start="true" label="Start hosted analysis" icon="i-lucide-play" :loading="submitting" :disabled="!ready" @click="start" />
      <p v-if="submitError" class="mt-4 text-sm text-error" role="alert">{{ submitError }}</p>
    </UCard>
  </main>
</template>
