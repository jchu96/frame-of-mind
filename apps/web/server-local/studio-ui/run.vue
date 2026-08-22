<script setup lang="ts">
import type { JobCreateResult } from "../../../../src/domain/studio-ports";
import type {
  ContextFileReceipt,
  MediaRetentionRequest,
  MediaSession,
} from "../../../../src/domain/studio-schemas";
import {
  clearContextDraft,
  commitVideoOnlyContextDraft,
  createContextStagingTransport,
  loadContextDraft,
} from "./context-composer";
import { clearIntentDraft, loadIntentDraft } from "./intent-composer";
import {
  clearMediaResumeReceipt,
  createMediaStagingTransport,
  loadMediaResumeReceipt,
} from "./media-upload";
import {
  buildComposerPayload,
  canStartRunAnalysis,
  clearRunDraft,
  createOrLoadRunDraft,
  deriveRunReceiptState,
  retentionRequestForMediaSession,
  runRetentionDisplay,
  runFieldErrorForJobCode,
  startFreshRunReceipt,
  type RunDraft,
  type RunFieldError,
  type RunReceiptState,
} from "./run-composer";
import { useComposerReadiness } from "./use-composer-readiness";

interface RecipeCatalog {
  defaultModel: string;
  recipes: Array<{ id: string; label: string; revision: string }>;
}

useSeoMeta({
  title: "Run receipt · Frame of Mind",
  description: "Review exact local analysis inputs before starting Gemini transfer.",
});

const {
  data: catalog,
  error: catalogError,
  status: catalogStatus,
} = await useFetch<RecipeCatalog>("/api/studio/recipes", { server: false });
const { readiness, refresh: refreshReadiness } = useComposerReadiness();
const route = useRoute();
const mediaTransport = createMediaStagingTransport();
const contextTransport = createContextStagingTransport();
const browserMounted = ref(false);
const mediaSession = shallowRef<MediaSession>();
const contextFileReceipt = shallowRef<ContextFileReceipt>();
const runDraft = shallowRef<RunDraft>();
const receiptState = shallowRef<RunReceiptState>();
const loadingReceipt = ref(true);
const submitting = ref(false);
const committingVideoOnly = ref(false);
const submitError = ref<string>();
const fieldError = ref<RunFieldError>();
let intentLoad = loadIntentDraft({
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});
let contextLoad = loadContextDraft({
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});

const retentionDisplay = computed(() =>
  runRetentionDisplay(mediaSession.value, runDraft.value)
);
const retainedTtlSeconds = computed(() =>
  retentionDisplay.value.ttlSeconds
);
const startAnalysisEnabled = computed(() =>
  canStartRunAnalysis(receiptState.value, runDraft.value)
  && !fieldError.value?.canStartFreshReceipt
);
const startAnalysisDescription = computed(() => {
  if (startAnalysisEnabled.value) return undefined;
  const ids: string[] = [];
  if (receiptState.value?.blockers.length) ids.push("run-blockers");
  if (fieldError.value) ids.push("run-field-error");
  if (submitError.value) ids.push("run-submit-error");
  if (!runDraft.value && mediaSession.value) {
    ids.push("run-retention-unavailable");
  }
  return ids.join(" ") || undefined;
});
const retentionOptions = [
  {
    label: "Ephemeral",
    value: "ephemeral",
    description: "Delete the staged copy after terminal job cleanup.",
  },
  {
    label: "Retained",
    value: "retained",
    description: "Keep the private staged copy until its server-owned expiry.",
  },
];
const retainedLifetimeOptions = [
  { label: "1 hour", value: 60 * 60 },
  { label: "1 day", value: 24 * 60 * 60 },
  { label: "7 days", value: 7 * 24 * 60 * 60 },
];

function refreshDerivedState(): void {
  receiptState.value = deriveRunReceiptState({
    intent: intentLoad,
    context: contextLoad,
    mediaSession: mediaSession.value,
    recipes: catalogError.value || catalogStatus.value === "pending"
      ? undefined
      : catalog.value?.recipes,
    readinessCanRun: readiness.value.canRun,
    now: new Date().toISOString(),
    contextFileAvailable: contextLoad.draft?.mode === "enriched"
        && contextLoad.draft.context.provider === "file"
      ? Boolean(contextFileReceipt.value)
      : true,
  });
}

watch([catalog, catalogError, catalogStatus, readiness], refreshDerivedState, {
  deep: true,
});

onMounted(async () => {
  browserMounted.value = true;
  intentLoad = loadIntentDraft(sessionStorage);
  contextLoad = loadContextDraft(sessionStorage);
  const mediaReceipt = loadMediaResumeReceipt(sessionStorage);
  if (mediaReceipt.mediaSessionId) {
    try {
      mediaSession.value = await mediaTransport.status(
        mediaReceipt.mediaSessionId,
      );
    } catch {
      mediaSession.value = undefined;
    }
  }
  if (
    contextLoad.draft?.mode === "enriched"
    && contextLoad.draft.context.provider === "file"
  ) {
    try {
      contextFileReceipt.value = await contextTransport.status(
        contextLoad.draft.context.contextFileId,
      );
    } catch {
      contextFileReceipt.value = undefined;
    }
  }
  await refreshReadiness();
  if (mediaSession.value) {
    let retention: MediaRetentionRequest | undefined;
    try {
      retention = retentionRequestForMediaSession(mediaSession.value);
    } catch {
      submitError.value =
        "The recording's retained lifetime is outside Run's supported range. Restage it with a supported retention choice.";
    }
    if (retention) {
      try {
        runDraft.value = createOrLoadRunDraft(sessionStorage, retention);
      } catch {
        submitError.value =
          "Run retry state could not be saved. Enable browser session storage and reload.";
      }
    }
  }
  refreshDerivedState();
  loadingReceipt.value = false;
});

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function contextIdentity(): string {
  const draft = receiptState.value?.context.draft;
  if (!draft || draft.mode === "video-only") return "No external context";
  const context = draft.context;
  if (context.provider === "file") return context.contextFileId;
  return `${context.provider} · ${context.meetingId}`;
}

function responseCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const object = body as { data?: unknown };
  if (!object.data || typeof object.data !== "object") return undefined;
  const code = (object.data as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function startAnalysis(): Promise<void> {
  if (submitting.value || !receiptState.value || !runDraft.value) return;
  submitError.value = undefined;
  fieldError.value = undefined;
  let payload;
  try {
    payload = buildComposerPayload(receiptState.value, runDraft.value);
  } catch {
    submitError.value = "Run receipt is blocked. Resolve every item before starting.";
    return;
  }
  submitting.value = true;
  try {
    const response = await fetch("/api/studio/composer/jobs", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      fieldError.value = runFieldErrorForJobCode(responseCode(body));
      return;
    }
    const result = body as JobCreateResult;
    clearIntentDraft(sessionStorage);
    clearContextDraft(sessionStorage);
    clearMediaResumeReceipt(sessionStorage);
    clearRunDraft(sessionStorage);
    await navigateTo({
      path: "/",
      query: { created: result.job.id },
    });
  } catch {
    submitError.value =
      "The local Studio could not confirm job creation. Retry uses the same key and cannot create a duplicate.";
  } finally {
    submitting.value = false;
  }
}

function startFreshReceipt(): void {
  if (!runDraft.value) return;
  submitError.value = undefined;
  try {
    runDraft.value = startFreshRunReceipt(
      sessionStorage,
      runDraft.value.retention,
    );
    fieldError.value = undefined;
  } catch {
    submitError.value =
      "A fresh Run retry key could not be saved. Enable browser session storage and try again.";
  }
}

function canContinueWithoutContext(code: string): boolean {
  return code === "context_missing" || code === "context_uncommitted";
}

async function continueWithoutContext(): Promise<void> {
  if (committingVideoOnly.value) return;
  submitError.value = undefined;
  committingVideoOnly.value = true;
  try {
    if (!commitVideoOnlyContextDraft(sessionStorage)) {
      submitError.value =
        "The browser could not save the recording-only choice. Enable browser session storage and try again.";
      return;
    }
    contextLoad = loadContextDraft(sessionStorage);
    contextFileReceipt.value = undefined;
    await refreshReadiness();
    refreshDerivedState();
  } finally {
    committingVideoOnly.value = false;
  }
}
</script>

<template>
  <div data-run-step="local">
    <AppHeader />
    <main class="fom-shell py-10 sm:py-14">
      <section class="grid gap-8 lg:grid-cols-[1fr_0.6fr] lg:items-end">
        <div>
          <p class="fom-kicker text-primary">Local Studio · Run</p>
          <h1 class="mt-4 text-4xl font-black tracking-[-0.045em] sm:text-6xl">
            Review the exact run receipt.
          </h1>
          <p class="mt-5 max-w-3xl text-base leading-7 text-muted sm:text-lg">
            This receipt binds the recording, context, intent, model, and
            cleanup policy that the local worker will enforce again.
          </p>
        </div>
        <UAlert
          color="neutral"
          variant="soft"
          icon="i-lucide-file-check-2"
          title="Nothing transfers until Start analysis"
          description="The staged recording stays in private local application data until this final action creates one durable local job."
        />
      </section>

      <div
        v-if="!browserMounted || loadingReceipt"
        class="mt-10 flex items-center gap-3 text-sm text-muted"
        role="status"
        aria-live="polite"
      >
        <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
        Reading the private composer receipts…
      </div>

      <section v-else class="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="space-y-6">
          <div
            v-if="receiptState?.blockers.length"
            id="run-blockers"
            class="space-y-3"
            role="alert"
            aria-live="polite"
          >
            <UAlert
              v-for="blocker in receiptState.blockers"
              :key="blocker.code"
              color="error"
              variant="soft"
              icon="i-lucide-shield-alert"
              title="BLOCKED"
              :description="canContinueWithoutContext(blocker.code)
                ? 'Add meeting context, or continue with the recording only.'
                : blocker.message"
            >
              <template #actions>
                <UButton
                  v-if="canContinueWithoutContext(blocker.code)"
                  type="button"
                  color="primary"
                  size="sm"
                  :loading="committingVideoOnly"
                  @click="continueWithoutContext"
                >
                  Continue without context
                </UButton>
                <UButton
                  :to="blocker.link"
                  color="neutral"
                  variant="outline"
                  size="sm"
                >
                  Open {{ blocker.link.slice(1) }}
                </UButton>
              </template>
            </UAlert>
          </div>

          <UCard>
            <template #header>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="fom-kicker text-muted">Recording</p>
                  <h2 class="mt-2 text-2xl font-black">Staged recording</h2>
                </div>
                <UBadge :color="receiptState?.recording.blocker ? 'error' : 'success'" variant="soft">
                  {{ receiptState?.recording.blocker ? "Blocked" : "Sealed" }}
                </UBadge>
              </div>
            </template>
            <dl v-if="mediaSession" class="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Recording</dt>
                <dd class="mt-1 font-semibold">Authorized local recording</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Size</dt>
                <dd class="mt-1 font-semibold">{{ formatBytes(mediaSession.expectedBytes) }}</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">SHA-256 receipt</dt>
                <dd class="mt-1 font-mono">{{ mediaSession.sha256?.slice(0, 12) }}…</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Storage</dt>
                <dd class="mt-1">Private local application data, outside this checkout</dd>
              </div>
            </dl>
          </UCard>

          <UCard>
            <template #header>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="fom-kicker text-muted">Context</p>
                  <h2 class="mt-2 text-2xl font-black">{{ receiptState?.context.label }}</h2>
                </div>
                <UBadge :color="receiptState?.context.blocker ? 'error' : 'success'" variant="soft">
                  {{ receiptState?.context.blocker ? "Blocked" : "Committed" }}
                </UBadge>
              </div>
            </template>
            <dl v-if="receiptState?.context.draft" class="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Source</dt>
                <dd class="mt-1 break-all">{{ contextIdentity() }}</dd>
              </div>
              <div v-if="contextFileReceipt">
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Local receipt</dt>
                <dd class="mt-1">{{ formatBytes(contextFileReceipt.bytes) }} · {{ contextFileReceipt.id }}</dd>
              </div>
              <div v-if="receiptState.context.draft.mode === 'enriched' && receiptState.context.draft.transcriptOffsetSeconds !== undefined">
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Transcript offset</dt>
                <dd class="mt-1">{{ receiptState.context.draft.transcriptOffsetSeconds }} seconds</dd>
              </div>
            </dl>
          </UCard>

          <UCard>
            <template #header>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="fom-kicker text-muted">Intent</p>
                  <h2 class="mt-2 text-2xl font-black">{{ receiptState?.intent.label }}</h2>
                </div>
                <UBadge :color="receiptState?.intent.blocker ? 'error' : 'success'" variant="soft">
                  {{ receiptState?.intent.blocker ? "Blocked" : "Pinned" }}
                </UBadge>
              </div>
            </template>
            <dl v-if="receiptState?.intent.draft" class="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Recipe revision</dt>
                <dd class="mt-1 font-mono">{{ 'custom' in receiptState.intent.draft.recipe ? 'custom' : receiptState.intent.draft.recipe.revision }}</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Model</dt>
                <dd class="mt-1">{{ receiptState.intent.draft.model }}</dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Focus</dt>
                <dd class="mt-1 whitespace-pre-wrap">{{ receiptState.intent.draft.focus || "No additional focus" }}</dd>
              </div>
            </dl>
          </UCard>

          <UCard>
            <template #header>
              <div>
                <p class="fom-kicker text-muted">Retention</p>
                <h2 class="mt-2 text-2xl font-black">Review the staged-media policy</h2>
              </div>
            </template>
            <UFormField
              label="Local recording retention"
              description="This exact choice was locked when staging began; the job receipt cannot extend it."
            >
              <URadioGroup
                v-if="retentionDisplay.mode !== 'unavailable'"
                :model-value="retentionDisplay.mode"
                :items="retentionOptions"
                variant="card"
                disabled
              />
              <p
                v-else
                id="run-retention-unavailable"
                class="mt-2 text-sm font-semibold text-error"
                role="status"
              >
                Unavailable
              </p>
            </UFormField>
            <USelect
              v-if="retainedTtlSeconds"
              :model-value="retainedTtlSeconds"
              :items="retainedLifetimeOptions"
              value-key="value"
              label-key="label"
              disabled
              class="mt-4 w-full sm:max-w-xs"
            />
            <p v-if="retentionDisplay.expiresAt" class="mt-4 text-sm text-muted">
              Server-owned expiry: {{ formatDate(retentionDisplay.expiresAt) }}
            </p>
          </UCard>

          <UAlert
            v-if="fieldError"
            id="run-field-error"
            role="alert"
            color="error"
            variant="soft"
            :title="fieldError.section === 'home'
              ? 'Retry key already used'
              : `${fieldError.section[0].toUpperCase()}${fieldError.section.slice(1)} needs attention`"
            :description="fieldError.message"
          >
            <template #actions>
              <UButton
                :to="fieldError.section === 'home' ? '/' : `/${fieldError.section}`"
                color="neutral"
                variant="outline"
                size="sm"
              >
                {{ fieldError.section === "home" ? "Open Home" : `Open ${fieldError.section}` }}
              </UButton>
              <UButton
                v-if="fieldError.canStartFreshReceipt"
                type="button"
                color="neutral"
                variant="outline"
                size="sm"
                @click="startFreshReceipt"
              >
                Start a fresh receipt
              </UButton>
            </template>
          </UAlert>
          <UAlert
            v-if="submitError"
            id="run-submit-error"
            role="alert"
            color="error"
            variant="soft"
            title="Job creation was not confirmed"
            :description="submitError"
          />
          <div class="flex flex-wrap gap-3">
            <UButton
              id="start-analysis"
              type="button"
              size="xl"
              icon="i-lucide-play"
              :loading="submitting"
              :disabled="!startAnalysisEnabled"
              :aria-describedby="startAnalysisDescription"
              @click="startAnalysis"
            >
              Start analysis
            </UButton>
            <UButton to="/intent" color="neutral" variant="outline">Review intent</UButton>
            <UButton to="/context" color="neutral" variant="outline">Review context</UButton>
            <UButton to="/recording" color="neutral" variant="outline">Review recording</UButton>
          </div>
        </div>

        <aside class="space-y-5" aria-label="Transfer and cleanup disclosures">
          <UAlert
            color="primary"
            variant="soft"
            icon="i-lucide-cloud-upload"
            title="Temporary Gemini transfer"
            description="After Start analysis, the local worker uploads the sealed recording to Gemini Files for analysis. Gemini receives no local path or browser storage."
          />
          <UAlert
            color="neutral"
            variant="outline"
            icon="i-lucide-trash-2"
            title="Cleanup is part of the run"
            description="The worker requests exact remote-file deletion on success and failure. Ephemeral local staging is deleted after terminal cleanup; retained staging expires on the server-owned deadline shown here."
          />
          <UAlert
            color="warning"
            variant="soft"
            icon="i-lucide-shield-alert"
            title="No silent context downgrade"
            description="Missing, expired, unreadable, or uncommitted context blocks this page. Only the explicit Video-only receipt creates a no-context job."
          />
        </aside>
      </section>
    </main>
  </div>
</template>
