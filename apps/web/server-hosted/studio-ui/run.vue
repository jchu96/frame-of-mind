<script setup lang="ts">
import { clearContextDraft, commitVideoOnlyContextDraft, loadContextDraft } from "../../app/studio/context-composer.js";
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
import { recordingDisplayLabel } from "../../app/studio/recording-display";
import {
  hostedRunStartErrorCopy,
  type HostedRunStartErrorAction,
} from "./run-start-error";

interface Recipe { id: string; label: string; revision: string }
useSeoMeta({
  title: "Review and start · Frame of Mind",
  description: "Review the hosted analysis settings before starting.",
});
const { data: catalog, error } = await useFetch<{ recipes: Recipe[] }>("/api/hosted/recipes");
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
const blockers = ref<Array<{ code: string; message: string; link: string; action: string }>>([]);
const ready = ref(false);
const submitting = ref(false);
const submitError = ref("");
const submitNextAction = ref("");
const submitErrorCode = ref("");
const submitErrorAction = ref<HostedRunStartErrorAction>();
const summary = ref<{
  recipe: string;
  focus: string;
  context: string;
  recording: string;
  recordingTitle: string;
}>();
let payload: ReturnType<typeof buildComposerPayload> | undefined;

onMounted(async () => {
  const storage = hostedStorage(sessionStorage);
  commitVideoOnlyContextDraft(storage);
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
    code: item.code,
    message: item.message,
    link: `/hosted/new${item.link}`,
    action: item.code.startsWith("intent") || item.code.startsWith("recipe")
      ? "Choose"
      : item.code.startsWith("context")
        ? "Confirm"
        : "Add recording",
  }));
  if (state.intent.blocker) {
    await navigateTo({
      path: "/hosted/new/intent",
      query: { reason: "Complete Intent before opening Run." },
    });
    return;
  }
  if (!session) {
    await navigateTo({
      path: "/hosted/new/recording",
      query: { reason: "Add a recording before Review & start." },
    });
    return;
  }
  summary.value = {
    recipe: state.intent.label,
    focus: state.intent.draft?.focus || "No optional focus",
    context: state.context.label === "Video-only" ? "Recording only" : state.context.label,
    recording: media
      ? `Uploaded ${formatDate(media.sealedAt)} · ${media.retention === "ephemeral" ? "deleted after analysis" : `kept until ${formatDate(media.expiresAt)}`}`
      : "No recording added",
    recordingTitle: media ? recordingDisplayLabel(media) : "No recording added",
  };
  if (!state.canSubmit) return;
  const draft = createOrLoadRunDraft(storage, retentionRequestForMediaSession(session), () => `hosted-run:${crypto.randomUUID()}`);
  payload = buildComposerPayload(state, draft);
  ready.value = true;
});

async function start(): Promise<void> {
  if (!payload || submitting.value) return;
  submitting.value = true;
  submitError.value = "";
  submitNextAction.value = "";
  submitErrorCode.value = "";
  submitErrorAction.value = undefined;
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
    const copy = hostedRunStartErrorCopy(code);
    submitError.value = copy.message;
    submitNextAction.value = copy.nextAction;
    submitErrorCode.value = typeof code === "string" ? code : "start_failed";
    submitErrorAction.value = copy.action;
  } finally {
    submitting.value = false;
  }
}

async function handleSubmitErrorAction(): Promise<void> {
  if (submitErrorAction.value?.kind === "retry") {
    await start();
    return;
  }
  if (submitErrorAction.value?.kind === "refresh") {
    reloadNuxtApp({ force: true });
    return;
  }
  if (submitErrorAction.value?.kind === "contact-support") {
    try {
      await navigator.clipboard.writeText(submitErrorCode.value);
    } catch {
      // The rendered support code stays visible and selectable as the fallback.
    }
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="run">
    <HostedComposerStepper current="run" :intent-ready="true" :recording-ready="ready" />
    <h1 class="text-4xl font-black">Review and start</h1>
    <div v-if="summary" class="mt-8 grid gap-4 lg:grid-cols-3" aria-label="Analysis summary">
      <UCard data-summary-card="intent">
        <p class="text-sm font-bold text-muted">What to find</p>
        <h2 class="mt-2 text-xl font-black">{{ summary.recipe }}</h2>
        <p class="mt-2 text-sm text-muted">{{ summary.focus }}</p>
        <p class="mt-3 text-xs text-dimmed">Analysed with Gemini</p>
      </UCard>
      <UCard data-summary-card="context">
        <p class="text-sm font-bold text-muted">Sources</p>
        <h2 class="mt-2 text-xl font-black">{{ summary.context }}</h2>
        <p class="mt-2 text-sm text-muted">No transcript or meeting notes will be added.</p>
      </UCard>
      <UCard data-summary-card="recording">
        <p class="text-sm font-bold text-muted">Recording</p>
        <h2 class="mt-2 text-xl font-black">{{ summary.recordingTitle }}</h2>
        <p class="mt-2 text-sm text-muted">{{ summary.recording }}</p>
      </UCard>
    </div>
    <UAlert
      class="mt-6 max-w-4xl"
      color="primary"
      variant="soft"
      title="Before you start"
      description="Your recording will be sent to Google Gemini for analysis and deleted from Gemini when it finishes. The settings above are saved with the results so you can see exactly how they were produced."
    />
    <div v-if="blockers.length" class="mt-6 max-w-4xl space-y-3">
      <UAlert v-for="blocker in blockers" :key="blocker.code" color="warning" variant="soft" :title="blocker.message">
        <template #actions>
          <UButton :to="blocker.link" external size="xs" color="neutral" variant="outline" :label="blocker.action" />
        </template>
      </UAlert>
    </div>
    <div class="mt-6">
      <UButton data-hosted-run-start="true" label="Start analysis" icon="i-lucide-play" :loading="submitting" :disabled="!ready" @click="start" />
      <p v-if="!ready" class="mt-2 text-sm text-muted">Complete the steps above before starting.</p>
      <UAlert
        v-if="submitError"
        class="mt-4 max-w-2xl"
        color="error"
        variant="soft"
        :title="submitError"
        :description="submitNextAction"
        role="alert"
      />
      <p v-if="submitErrorCode" class="mt-3 text-sm text-muted">
        Support code: <code>{{ submitErrorCode }}</code>
      </p>
      <UButton
        v-if="submitErrorAction && 'to' in submitErrorAction"
        class="mt-3"
        :to="submitErrorAction.to"
        color="neutral"
        variant="outline"
        :label="submitErrorAction.label"
      />
      <UButton
        v-else-if="submitErrorAction"
        class="mt-3"
        type="button"
        color="neutral"
        variant="outline"
        :label="submitErrorAction.label"
        @click="handleSubmitErrorAction"
      />
    </div>
  </main>
</template>
