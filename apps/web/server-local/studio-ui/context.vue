<script setup lang="ts">
import {
  meetingCatalogPageSchema,
  type ConfigurationStatus,
  type MediaSession,
} from "../../../../src/domain/studio-schemas";
import type {
  MeetingCatalogItem,
} from "../../../../src/domain/studio-ports";
import {
  createMediaStagingTransport,
  loadMediaResumeReceipt,
} from "./media-upload";
import {
  clearContextDraft,
  createContextStagingTransport,
  loadContextDraft,
  parseTranscriptOffsetInput,
  persistContextDraft,
  previewContextFile,
  validateContextFile,
  type ContextDraft,
  type ContextFileReceipt,
} from "./context-composer";

useSeoMeta({
  title: "Context · Frame of Mind",
  description: "Choose meeting context for a private local analysis.",
});

type SourceKey =
  | "bluedot:mcp"
  | "granola:mcp"
  | "granola:api"
  | "file:file";
type ProviderStatus = ConfigurationStatus["providers"][number];

const sourceOptions = [
  {
    label: "Bluedot",
    value: "bluedot:mcp",
    description: "OAuth · browse recent meetings or enter an exact video ID.",
  },
  {
    label: "Granola MCP",
    value: "granola:mcp",
    description: "OAuth · enter an exact meeting or note ID.",
  },
  {
    label: "Granola API",
    value: "granola:api",
    description: "API key · enter an exact not_… note ID.",
  },
  {
    label: "Local context",
    value: "file:file",
    description: "Private JSON, text, Markdown, SRT, or VTT upload.",
  },
] satisfies Array<{
  label: string;
  value: SourceKey;
  description: string;
}>;

const {
  data: configuration,
  error: configurationError,
  status: configurationLoadStatus,
} = await useFetch<ConfigurationStatus>("/api/studio/configuration", {
  server: false,
});
const mediaTransport = createMediaStagingTransport();
const contextTransport = createContextStagingTransport();
const toast = useToast();

const source = ref<SourceKey>("bluedot:mcp");
const meetingId = ref("");
const transcriptOffset = ref("");
const offsetError = ref<string>();
const formError = ref<string>();
const storageWarning = ref<string>();
const saved = ref(false);
const media = shallowRef<MediaSession>();
const mediaLoading = ref(true);
const selectedFile = shallowRef<File>();
const fileError = ref<string>();
const filePreview = ref("");
const previewTruncated = ref(false);
const contextReceipt = shallowRef<ContextFileReceipt>();
const contextBusy = ref(false);
const catalogQuery = ref("");
const catalogItems = ref<MeetingCatalogItem[]>([]);
const catalogCursor = ref<string>();
const catalogLoading = ref(false);
const catalogError = ref<string>();
const browserMounted = ref(false);

const sourceModel = computed<SourceKey>({
  get: () => source.value,
  set: (next) => {
    if (contextReceipt.value && next !== "file:file") {
      formError.value =
        "Delete the staged local context before switching providers.";
      return;
    }
    source.value = next;
    meetingId.value = "";
    catalogItems.value = [];
    catalogCursor.value = undefined;
    catalogError.value = undefined;
    formError.value = undefined;
    saved.value = false;
  },
});

const fileModel = computed<File | null>({
  get: () => selectedFile.value ?? null,
  set: (next) => {
    if (contextReceipt.value) {
      fileError.value =
        "Delete the current staged context before choosing another file.";
      return;
    }
    selectedFile.value = next ?? undefined;
    fileError.value = undefined;
    filePreview.value = "";
    previewTruncated.value = false;
    saved.value = false;
    if (!next) return;
    const validation = validateContextFile(next);
    if (!validation.ok) {
      fileError.value = validation.message;
      return;
    }
    void previewContextFile(next).then((preview) => {
      if (selectedFile.value !== next) return;
      filePreview.value = preview.text;
      previewTruncated.value = preview.truncated;
    }).catch(() => {
      if (selectedFile.value === next) {
        fileError.value = "The browser could not preview this context file.";
      }
    });
  },
});

const mediaReady = computed(() =>
  Boolean(
    media.value?.sha256
    && ["sealed", "retained", "in_use"].includes(media.value.status),
  )
);
const isLocalContext = computed(() => source.value === "file:file");
const isBluedot = computed(() => source.value === "bluedot:mcp");
const selectedCatalogItem = computed(() =>
  catalogItems.value.find((item) => item.id === meetingId.value)
);
const connection = computed<ProviderStatus | undefined>(() => {
  const providerName = source.value.split(":", 1)[0];
  return configuration.value?.providers.find(
    (candidate) => candidate.provider === providerName,
  );
});
const sourceConnected = computed(() => {
  if (isLocalContext.value) return true;
  const current = connection.value;
  if (!current?.connected) return false;
  if (source.value === "bluedot:mcp") return current.source === "oauth";
  if (source.value === "granola:mcp") return current.source === "oauth";
  return current.source === "environment" || current.source === "session";
});

function sourceFromDraft(draft: ContextDraft): SourceKey {
  const context = draft.context;
  return `${context.provider}:${context.transport}` as SourceKey;
}

function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3_600);
  const minutes = Math.floor((absolute % 3_600) / 60);
  const remainder = absolute % 60;
  return `${sign}${[hours, minutes, remainder]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")}`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  return `${(value / 1_024).toFixed(1)} KiB`;
}

onMounted(() => {
  browserMounted.value = true;
});

onMounted(async () => {
  const mediaReceipt = loadMediaResumeReceipt(sessionStorage);
  if (!mediaReceipt.storageAvailable) {
    storageWarning.value =
      "Browser session storage is unavailable. Return to Recording and keep this tab open.";
    mediaLoading.value = false;
    return;
  }
  if (mediaReceipt.mediaSessionId) {
    try {
      media.value = await mediaTransport.status(mediaReceipt.mediaSessionId);
    } catch {
      media.value = undefined;
    }
  }

  const restored = loadContextDraft(sessionStorage);
  if (!restored.storageAvailable) {
    storageWarning.value =
      "Context draft storage is unavailable. Staged server receipts remain authoritative.";
  } else if (
    restored.draft
    && restored.draft.mediaSessionId === media.value?.id
  ) {
    source.value = sourceFromDraft(restored.draft);
    if ("meetingId" in restored.draft.context) {
      meetingId.value = restored.draft.context.meetingId;
    } else {
      try {
        contextReceipt.value = await contextTransport.status(
          restored.draft.context.contextFileId,
        );
      } catch {
        clearContextDraft(sessionStorage);
      }
    }
    if (restored.draft.transcriptOffsetSeconds !== undefined) {
      transcriptOffset.value = formatOffset(
        restored.draft.transcriptOffsetSeconds,
      );
    }
    saved.value = restored.draft.committed && Boolean(
      "meetingId" in restored.draft.context || contextReceipt.value,
    );
  }
  mediaLoading.value = false;
});

async function loadCatalog(append = false) {
  if (!isBluedot.value || catalogLoading.value) return;
  catalogLoading.value = true;
  catalogError.value = undefined;
  try {
    const page = meetingCatalogPageSchema.parse(await $fetch(
      "/api/studio/catalog/bluedot",
      {
        query: {
          transport: "mcp",
          limit: 8,
          ...(catalogQuery.value.trim()
            ? { query: catalogQuery.value.trim() }
            : {}),
          ...(append && catalogCursor.value
            ? { cursor: catalogCursor.value }
            : {}),
        },
      },
    ));
    const combined = append
      ? [...catalogItems.value, ...page.items]
      : page.items;
    catalogItems.value = combined.filter(
      (item, index, all) =>
        all.findIndex((candidate) => candidate.id === item.id) === index,
    );
    catalogCursor.value = page.nextCursor;
  } catch {
    catalogError.value =
      "Recent meetings are unavailable. Reconnect Bluedot or enter the exact video ID.";
    if (!append) catalogItems.value = [];
    catalogCursor.value = undefined;
  } finally {
    catalogLoading.value = false;
  }
}

function selectCatalogMeeting(item: MeetingCatalogItem) {
  meetingId.value = item.id;
  formError.value = undefined;
  saved.value = false;
}

async function stageContext() {
  const file = selectedFile.value;
  if (!file || contextBusy.value) {
    fileError.value ||= "Choose a local context file first.";
    return;
  }
  const validation = validateContextFile(file);
  if (!validation.ok) {
    fileError.value = validation.message;
    return;
  }
  contextBusy.value = true;
  fileError.value = undefined;
  try {
    contextReceipt.value = await contextTransport.stage(
      file,
      validation.format,
    );
    saved.value = false;
    if (media.value?.id) persistCurrentDraft(false);
  } catch {
    fileError.value =
      "Context staging failed. Verify the file format and try again.";
  } finally {
    contextBusy.value = false;
  }
}

async function deleteContext() {
  if (!contextReceipt.value || contextBusy.value) return;
  contextBusy.value = true;
  try {
    await contextTransport.delete(contextReceipt.value.id);
    contextReceipt.value = undefined;
    saved.value = false;
    clearContextDraft(sessionStorage);
  } catch {
    fileError.value =
      "The staged context could not be deleted. Retry before switching sources.";
  } finally {
    contextBusy.value = false;
  }
}

function currentContext(): ContextDraft["context"] | undefined {
  if (isLocalContext.value) {
    if (!contextReceipt.value) return undefined;
    return {
      provider: "file",
      transport: "file",
      contextFileId: contextReceipt.value.id,
      contextFileSha256: contextReceipt.value.sha256,
    };
  }
  const exactId = meetingId.value.trim();
  if (!exactId || exactId.length > 500) return undefined;
  if (source.value === "bluedot:mcp") {
    return { provider: "bluedot", transport: "mcp", meetingId: exactId };
  }
  return {
    provider: "granola",
    transport: source.value === "granola:api" ? "api" : "mcp",
    meetingId: exactId,
  };
}

function persistCurrentDraft(committed: boolean): boolean {
  const context = currentContext();
  if (!media.value?.id || !context) return false;
  const alignment = parseTranscriptOffsetInput(transcriptOffset.value);
  if (!alignment.ok) return false;
  return persistContextDraft(sessionStorage, {
    schemaVersion: 1,
    mediaSessionId: media.value.id,
    context,
    ...(alignment.seconds === undefined
      ? {}
      : { transcriptOffsetSeconds: alignment.seconds }),
    committed,
  });
}

async function saveContext() {
  formError.value = undefined;
  offsetError.value = undefined;
  if (!mediaReady.value) {
    formError.value = "Stage and seal a recording before choosing context.";
    return;
  }
  if (!sourceConnected.value) {
    formError.value =
      "Configure this exact provider transport in Connections before continuing.";
    return;
  }
  const context = currentContext();
  if (!context) {
    formError.value = isLocalContext.value
      ? "Stage one valid local context file."
      : "Choose a meeting or enter its exact ID.";
    return;
  }
  const alignment = parseTranscriptOffsetInput(transcriptOffset.value);
  if (!alignment.ok) {
    offsetError.value = alignment.message;
    return;
  }
  if ("contextFileId" in context) {
    try {
      contextReceipt.value = await contextTransport.status(
        context.contextFileId,
      );
    } catch {
      contextReceipt.value = undefined;
      formError.value =
        "The staged context expired or was consumed. Stage it again.";
      return;
    }
  }
  if (!persistCurrentDraft(true)) {
    storageWarning.value =
      "The browser could not save this draft. Keep the tab open or delete staged context before leaving.";
    return;
  }
  saved.value = true;
  toast.add({
    title: "Context saved for this analysis",
    description: "Only typed identifiers and receipts were stored in this browser session.",
    color: "success",
    icon: "i-lucide-check",
  });
}
</script>

<template>
  <div data-context-step="local">
    <AppHeader />
    <main class="fom-shell py-10 sm:py-14">
      <section class="grid gap-8 lg:grid-cols-[1fr_0.6fr] lg:items-end">
        <div>
          <p class="fom-kicker text-primary">Local Studio · Context</p>
          <h1 class="mt-4 text-4xl font-black tracking-[-0.045em] sm:text-6xl">
            Pair the recording with what was said.
          </h1>
          <p class="mt-5 max-w-3xl text-base leading-7 text-muted sm:text-lg">
            Choose one explicit provider transport or a bounded local file.
            Frame of Mind never switches accounts, providers, or meeting IDs
            behind the scenes.
          </p>
        </div>
        <UAlert
          color="neutral"
          variant="soft"
          icon="i-lucide-shield-check"
          title="Context and media stay separate"
          description="Meeting text is normalized only when the local job runs. Provider payloads and complete transcripts are not saved in this draft."
        />
      </section>

      <UAlert
        v-if="storageWarning"
        class="mt-6"
        color="warning"
        variant="soft"
        icon="i-lucide-triangle-alert"
        title="Refresh-safe draft is limited"
        :description="storageWarning"
      />

      <section class="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div v-if="browserMounted" class="space-y-6">
          <UCard>
            <template #header>
              <div>
                <p class="fom-kicker text-muted">2 · Context</p>
                <h2 class="mt-2 text-2xl font-black">Choose an exact source</h2>
              </div>
            </template>

            <fieldset aria-describedby="context-source-description">
              <legend class="text-sm font-medium text-highlighted">
                Context provider and transport
                <span aria-hidden="true" class="text-error">*</span>
              </legend>
              <p
                id="context-source-description"
                class="mt-1 text-sm text-muted"
              >
                Each option uses only its named identity and credential.
              </p>
              <div class="mt-3 grid gap-3">
                <label
                  v-for="item in sourceOptions"
                  :key="item.value"
                  class="flex cursor-pointer items-start gap-3 rounded-xl border border-default bg-default p-4 transition hover:bg-elevated"
                >
                  <input
                    v-model="sourceModel"
                    type="radio"
                    name="context-source"
                    :value="item.value"
                    class="mt-1 size-4 accent-[var(--ui-primary)]"
                  >
                  <span>
                    <span class="block text-sm font-medium text-highlighted">
                      {{ item.label }}
                    </span>
                    <span class="mt-1 block text-sm text-muted">
                      {{ item.description }}
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            <UAlert
              v-if="configurationError"
              class="mt-5"
              color="error"
              variant="soft"
              title="Connection status is unavailable"
              description="Restart Studio and open its new one-time launch URL."
            />
            <UAlert
              v-else-if="!isLocalContext && configurationLoadStatus !== 'pending' && !sourceConnected"
              class="mt-5"
              color="warning"
              variant="soft"
              icon="i-lucide-plug-zap"
              title="This transport is not configured"
              description="Open Connections to configure this exact OAuth or API-key path. Frame of Mind will not fall back to another credential."
              :actions="[{
                label: 'Open Connections',
                to: '/connections',
                color: 'neutral',
                variant: 'outline',
              }]"
            />
          </UCard>

          <UCard v-if="!isLocalContext">
            <template #header>
              <div>
                <p class="fom-kicker text-muted">Meeting</p>
                <h2 class="mt-2 text-2xl font-black">
                  {{ isBluedot ? "Browse or enter the video ID" : "Enter the exact meeting ID" }}
                </h2>
              </div>
            </template>

            <div v-if="isBluedot" class="space-y-4">
              <form
                class="flex flex-col gap-3 sm:flex-row"
                @submit.prevent="loadCatalog(false)"
              >
                <UInput
                  v-model="catalogQuery"
                  class="min-w-0 flex-1"
                  aria-label="Search Bluedot meetings"
                  placeholder="Search titles, descriptions, or transcript"
                  :disabled="catalogLoading || !sourceConnected"
                />
                <UButton
                  type="submit"
                  icon="i-lucide-search"
                  :loading="catalogLoading"
                  :disabled="!sourceConnected"
                >
                  {{ catalogQuery.trim() ? "Search" : "Browse recent" }}
                </UButton>
              </form>

              <UAlert
                v-if="catalogError"
                color="warning"
                variant="soft"
                title="Meeting catalog unavailable"
                :description="catalogError"
              />

              <div
                v-if="catalogItems.length"
                class="grid gap-3"
                aria-label="Bluedot meeting results"
              >
                <button
                  v-for="item in catalogItems"
                  :key="item.id"
                  type="button"
                  class="rounded-lg border p-4 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  :class="meetingId === item.id
                    ? 'border-primary bg-primary/10'
                    : 'border-default bg-default hover:bg-elevated'"
                  @click="selectCatalogMeeting(item)"
                >
                  <span class="block font-bold text-highlighted">
                    {{ item.title || "Untitled meeting" }}
                  </span>
                  <span class="mt-1 block text-sm text-muted">
                    {{ formatDate(item.createdAt) }}
                  </span>
                  <span class="mt-2 block break-all font-mono text-xs text-dimmed">
                    {{ item.id }}
                  </span>
                </button>
                <UButton
                  v-if="catalogCursor"
                  type="button"
                  color="neutral"
                  variant="outline"
                  :loading="catalogLoading"
                  @click="loadCatalog(true)"
                >
                  Load more
                </UButton>
              </div>
            </div>

            <UAlert
              v-else
              class="mb-5"
              color="neutral"
              variant="soft"
              icon="i-lucide-list-x"
              title="Exact-ID fallback"
              description="This transport has no catalog adapter in this release. Enter the provider ID directly; no other transport will be tried."
            />

            <UFormField
              class="mt-5"
              label="Exact meeting ID"
              :description="source === 'granola:api'
                ? 'Granola Personal API note IDs use the not_… format.'
                : 'Use the ID from the provider URL or meeting catalog.'"
              required
            >
              <UInput
                v-model="meetingId"
                class="w-full"
                autocomplete="off"
                maxlength="500"
                placeholder="Provider meeting ID"
                @update:model-value="saved = false"
              />
            </UFormField>

            <UAlert
              v-if="selectedCatalogItem"
              class="mt-5"
              color="primary"
              variant="soft"
              icon="i-lucide-check"
              title="Selected meeting"
              :description="`${selectedCatalogItem.title || 'Untitled meeting'} · ${formatDate(selectedCatalogItem.createdAt)}`"
            />
          </UCard>

          <UCard v-else>
            <template #header>
              <div>
                <p class="fom-kicker text-muted">Local context</p>
                <h2 class="mt-2 text-2xl font-black">Stage one bounded text source</h2>
              </div>
            </template>

            <UFormField
              label="Context file"
              description="JSON, text, Markdown, SRT, or VTT; 8 MiB maximum; single-use after analysis starts."
              :error="fileError"
              required
            >
              <UFileUpload
                v-model="fileModel"
                accept=".json,.txt,.md,.markdown,.srt,.vtt,application/json,text/plain,text/markdown,application/x-subrip,text/vtt"
                label="Drop local context here"
                description="or press Enter to choose a file"
                icon="i-lucide-file-text"
                layout="list"
                position="inside"
                :multiple="false"
                :disabled="contextBusy || Boolean(contextReceipt)"
                :file-image="false"
                class="min-h-44 w-full"
              />
            </UFormField>

            <div
              v-if="filePreview"
              class="mt-5 rounded-lg border border-default bg-elevated/50 p-4"
            >
              <div class="flex items-center justify-between gap-3">
                <p class="text-xs font-bold uppercase tracking-wider text-muted">
                  Local preview
                </p>
                <UBadge v-if="previewTruncated" color="neutral" variant="outline">
                  First 4 KiB
                </UBadge>
              </div>
              <pre class="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs text-default">{{ filePreview }}</pre>
            </div>

            <div class="mt-5 flex flex-wrap gap-3">
              <UButton
                v-if="!contextReceipt"
                type="button"
                icon="i-lucide-hard-drive-upload"
                :loading="contextBusy"
                :disabled="!selectedFile || Boolean(fileError)"
                @click="stageContext"
              >
                Stage context locally
              </UButton>
              <UButton
                v-else
                type="button"
                color="error"
                variant="soft"
                icon="i-lucide-trash-2"
                :loading="contextBusy"
                @click="deleteContext"
              >
                Delete staged context
              </UButton>
            </div>

            <dl
              v-if="contextReceipt"
              class="mt-5 grid gap-4 border-t border-default pt-5 text-sm sm:grid-cols-2"
            >
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Format</dt>
                <dd class="mt-1 font-semibold uppercase">{{ contextReceipt.format }}</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Size</dt>
                <dd class="mt-1 font-semibold">{{ formatBytes(contextReceipt.bytes) }}</dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-xs font-bold uppercase tracking-wider text-muted">Expires</dt>
                <dd class="mt-1">{{ formatDate(contextReceipt.expiresAt) }}</dd>
              </div>
            </dl>
          </UCard>

          <UCard>
            <details>
              <summary class="cursor-pointer font-black text-highlighted">
                Advanced transcript alignment
              </summary>
              <div class="mt-5">
                <UFormField
                  label="Transcript time at recording 00:00:00"
                  description="Leave blank for model alignment. Use a negative value only when the transcript begins after the selected recording."
                  :error="offsetError"
                >
                  <UInput
                    id="studio-transcript-offset"
                    v-model="transcriptOffset"
                    class="w-full sm:max-w-sm"
                    inputmode="text"
                    placeholder="01:02:47 or -00:04:30"
                    @update:model-value="offsetError = undefined; saved = false"
                  />
                </UFormField>
              </div>
            </details>
          </UCard>

          <UAlert
            v-if="formError"
            color="error"
            variant="soft"
            icon="i-lucide-triangle-alert"
            title="Context needs attention"
            :description="formError"
          />
          <UAlert
            v-if="saved"
            color="success"
            variant="soft"
            icon="i-lucide-check-circle"
            title="Context step saved"
            description="The next composer task is Intent. No provider transcript has been fetched and no Gemini upload has started."
          />

          <div class="flex flex-wrap gap-3">
            <UButton
              to="/recording"
              color="neutral"
              variant="outline"
              icon="i-lucide-arrow-left"
            >
              Back to recording
            </UButton>
            <UButton
              type="button"
              icon="i-lucide-save"
              :disabled="mediaLoading"
              @click="saveContext"
            >
              Save context step
            </UButton>
          </div>
        </div>
        <UCard v-else aria-live="polite">
          <div class="flex items-center gap-3 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
            Preparing the private Context composer…
          </div>
        </UCard>

        <aside class="space-y-5" aria-label="Context privacy details">
          <UAlert
            :color="mediaReady ? 'success' : 'warning'"
            variant="soft"
            :icon="mediaReady ? 'i-lucide-check-circle' : 'i-lucide-video-off'"
            :title="mediaReady ? 'Recording ready' : 'Recording required'"
            :description="mediaReady
              ? 'The sealed local media receipt is available for this draft.'
              : 'Return to Recording and seal one file before saving context.'"
          />
          <UAlert
            color="neutral"
            variant="outline"
            icon="i-lucide-clock-3"
            title="Local context is short-lived"
            description="A local context copy expires after one hour and is deleted after normalization on success, failure, or cancellation."
          />
          <UAlert
            color="primary"
            variant="soft"
            icon="i-lucide-route"
            title="No silent fallback"
            description="Catalog failure falls back only to exact-ID entry for the same transport. It never changes provider, workspace, account, or credential."
          />
        </aside>
      </section>
    </main>
  </div>
</template>
