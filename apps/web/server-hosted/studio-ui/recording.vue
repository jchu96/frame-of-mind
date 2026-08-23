<script setup lang="ts">
import { loadIntentDraft } from "../../app/studio/intent-composer.js";
import { hostedStorage } from "./hosted-adapter";
import HostedComposerStepper from "./composer-stepper.vue";
import { useHostedMediaUpload } from "./use-hosted-media-upload";

useSeoMeta({
  title: "Add a recording · Frame of Mind",
  description: "Add the recording for a hosted analysis.",
});

const { error } = await useFetch("/api/hosted/media/configuration", {
  headers: useRequestHeaders(["cookie"]),
});
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });

const {
  busy, cancel, discardOpenSession, draft, fieldError, fileModel, media,
  openSessions, operationError, pause, phase, progressBytes, resumeOpenSession,
  retention, start, statusMessage, totalBytes,
} = useHostedMediaUpload();
const route = useRoute();
const intentReady = ref(false);

onMounted(() => {
  intentReady.value = Boolean(loadIntentDraft(hostedStorage(sessionStorage)).draft);
});

const retentionOptions = [
  {
    label: "Delete after analysis",
    value: "ephemeral",
    description: "Delete the recording from Gemini after this analysis or an abandoned upload.",
  },
  {
    label: "Keep temporarily",
    value: "retained",
    description: "Keep a private copy for playback and evidence capture for 30 days by default.",
  },
];

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), 3);
  return `${(bytes / 1_024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date);
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="recording">
    <HostedComposerStepper current="recording" :intent-ready="intentReady" :recording-ready="Boolean(media)" />
    <UAlert v-if="typeof route.query.reason === 'string' && !media" class="mb-6" color="warning" variant="soft" :description="route.query.reason" />
    <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <UForm :state="{ retention }" class="space-y-6" @submit="start">
        <header>
          <h1 class="text-4xl font-black text-highlighted">Add your recording</h1>
          <p class="mt-4 max-w-2xl text-default">
            Your browser checks the complete file, then sends it directly to a
            short-lived Gemini upload session. In retained mode, the same
            committed bytes also go through a single-use capability to your
            private recording copy.
          </p>
          <UButton
            v-if="!media && !draft"
            class="mt-4"
            to="/hosted/activity"
            label="Back to Activity"
            color="neutral"
            variant="outline"
            icon="i-lucide-arrow-left"
          />
        </header>

        <UCard v-if="openSessions.length" data-hosted-open-sessions>
          <template #header>
            <div>
              <h2 class="text-xl font-black text-highlighted">Unfinished uploads</h2>
              <p class="mt-1 text-sm text-muted">
                These uploads are still open for your account. Resume one after
                choosing the same recording, or discard it to free capacity.
              </p>
            </div>
          </template>
          <ul class="space-y-3">
            <li
              v-for="session in openSessions"
              :key="session.mediaId"
              class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-default p-4"
              :data-hosted-open-session="session.mediaId"
            >
              <div>
                <p class="font-semibold text-default">{{ formatBytes(session.declaredSizeBytes) }} recording</p>
                <p class="mt-1 text-sm text-muted">
                  <template v-if="session.retention === 'ephemeral'">Delete after analysis</template><template v-else>Keep temporarily</template>
                  · expires <time :datetime="session.sessionExpiresAt" :title="session.sessionExpiresAt">{{ formatDate(session.sessionExpiresAt) }}</time>
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <UButton
                  type="button"
                  variant="soft"
                  :data-hosted-resume-session="session.mediaId"
                  :disabled="busy || Boolean(draft)"
                  @click="resumeOpenSession(session)"
                >
                  Resume
                </UButton>
                <UButton
                  type="button"
                  color="error"
                  variant="soft"
                  :data-hosted-discard-session="session.mediaId"
                  :disabled="busy || Boolean(draft)"
                  @click="discardOpenSession(session)"
                >
                  Discard
                </UButton>
              </div>
            </li>
          </ul>
        </UCard>

        <UCard>
          <UFormField
            label="Screen recording"
            description="MP4, MOV, M4V, or WebM; one file; configured hosted limit applies."
            :error="fieldError"
            required
          >
            <UFileUpload
              v-model="fileModel"
              accept=".mp4,.mov,.m4v,.webm,video/mp4,video/quicktime,video/webm"
              label="Drop a recording here"
              description="or choose one from this device"
              icon="i-lucide-video"
              layout="list"
              position="inside"
              :multiple="false"
              :disabled="busy || Boolean(media) || openSessions.length > 0"
              :file-image="false"
              class="min-h-52 w-full"
            />
          </UFormField>

          <UFormField
            class="mt-6"
            name="retention"
            label="Retention"
            description="Choose how long Gemini may keep this recording."
          >
            <URadioGroup
              v-model="retention"
              :items="retentionOptions"
              variant="card"
              :disabled="busy || Boolean(draft) || Boolean(media) || openSessions.length > 0"
            />
          </UFormField>
        </UCard>

        <UCard v-if="phase !== 'idle'" :data-hosted-media-ready="media ? 'true' : undefined">
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h2 class="text-xl font-black text-highlighted">Upload progress</h2>
              <UBadge
                role="status"
                :color="phase === 'sealed' ? 'success' : phase === 'failed' ? 'error' : phase === 'paused' || phase === 'reselect-required' ? 'warning' : 'primary'"
                variant="soft"
              >
                {{ phase.replaceAll('-', ' ') }}
              </UBadge>
            </div>
          </template>

          <p aria-live="polite" class="font-semibold text-default">{{ statusMessage }}</p>
          <p v-if="media?.keptUntil" class="mt-2 text-sm text-muted" data-hosted-kept-until>
            Private retained copy kept until {{ new Date(media.keptUntil).toLocaleString() }} unless you delete it sooner.
          </p>
          <div v-if="totalBytes" class="mt-5">
            <UProgress
              :model-value="progressBytes"
              :max="totalBytes"
              size="lg"
              aria-label="Recording upload progress"
            />
            <p class="mt-2 text-sm text-muted">
              {{ formatBytes(progressBytes) }} of {{ formatBytes(totalBytes) }}
              ({{ progressBytes.toLocaleString() }} of {{ totalBytes.toLocaleString() }} bytes)
            </p>
          </div>

          <UAlert
            v-if="operationError"
            class="mt-5"
            color="error"
            variant="soft"
            title="Upload needs attention"
            :description="operationError"
          />

          <div class="mt-6 flex flex-wrap gap-3">
            <UButton
              v-if="['selected', 'ready-to-resume', 'paused', 'failed'].includes(phase) && !media"
              type="submit"
              icon="i-lucide-cloud-upload"
              :disabled="!fileModel"
            >
              {{ draft ? 'Resume upload' : 'Start upload' }}
            </UButton>
            <UButton
              v-if="['hashing', 'uploading'].includes(phase)"
              type="button"
              color="neutral"
              variant="outline"
              icon="i-lucide-pause"
              @click="pause"
            >
              Pause
            </UButton>
            <UButton
              v-if="draft && !['sealed', 'canceling'].includes(phase)"
              type="button"
              color="error"
              variant="soft"
              icon="i-lucide-trash-2"
              @click="cancel"
            >
              Cancel upload
            </UButton>
            <UButton
              v-if="media"
              to="/hosted/new/run"
              trailing-icon="i-lucide-arrow-right"
            >
              Continue
            </UButton>
          </div>
        </UCard>
      </UForm>

      <aside class="space-y-5" aria-label="Recording privacy details">
        <UAlert
          color="primary"
          variant="soft"
          icon="i-lucide-shield-check"
          title="Direct browser upload"
          description="Your browser receives a write-only upload address, never the Gemini API key. File size and fingerprint must match before analysis can start."
        />
        <UAlert
          color="neutral"
          variant="outline"
          icon="i-lucide-image-off"
          title="Ephemeral review limits"
          description="Ephemeral runs have no playback or screenshot capture after this tab closes. Those features require retained media or exact-digest reattachment."
        />
        <UAlert
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          title="Resume after refresh"
          description="This tab stores only the upload receipt and last confirmed position. After refreshing, choose the same file to resume."
        />
        <UAlert
          color="warning"
          variant="soft"
          icon="i-lucide-shield-alert"
          title="Use authorized recordings only"
          description="Upload only recordings you are allowed to process. Upload addresses and recording content are never stored in logs, run bundles, or Git."
        />
      </aside>
    </section>
  </main>
</template>
