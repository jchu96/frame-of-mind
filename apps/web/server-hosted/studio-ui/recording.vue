<script setup lang="ts">
import { useHostedMediaUpload } from "./use-hosted-media-upload";

useSeoMeta({
  title: "Recording · Frame of Mind",
  description: "Upload one recording directly to a principal-bound Gemini session.",
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

const retentionOptions = [
  {
    label: "Ephemeral",
    value: "ephemeral",
    description: "Delete the Gemini file after analysis or abandoned-session cleanup.",
  },
  {
    label: "Retained",
    value: "retained",
    description: "Keep the sealed provider file until its bounded receipt expires.",
  },
];

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), 3);
  return `${(bytes / 1_024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="recording">
    <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <UForm :state="{ retention }" class="space-y-6" @submit="start">
        <header>
          <p class="fom-kicker text-primary">Step 3 of 4</p>
          <h1 class="mt-3 text-4xl font-black text-highlighted">Upload the recording</h1>
          <p class="mt-4 max-w-2xl text-default">
            Your browser hashes the complete file, then sends its bytes directly
            to one short-lived Gemini upload session. The Frame of Mind Worker
            never carries the recording bytes.
          </p>
        </header>

        <UCard v-if="openSessions.length" data-hosted-open-sessions>
          <template #header>
            <div>
              <h2 class="text-xl font-black text-highlighted">Unfinished uploads</h2>
              <p class="mt-1 text-sm text-muted">
                These principal-bound Gemini sessions are still open. Resume one
                after reselecting its recording, or discard it to free capacity.
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
                  {{ session.retention }} · expires {{ new Date(session.sessionExpiresAt).toLocaleString() }}
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
            description="This choice is bound into the upload declaration."
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
              <h2 class="text-xl font-black text-highlighted">Direct upload</h2>
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
              {{ draft ? 'Resume direct upload' : 'Start direct upload' }}
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
              Continue to run
            </UButton>
          </div>
        </UCard>
      </UForm>

      <aside class="space-y-5" aria-label="Recording privacy details">
        <UAlert
          color="primary"
          variant="soft"
          icon="i-lucide-shield-check"
          title="Keyless browser transfer"
          description="The browser receives one write-only session URL, never the Gemini API key. Size and SHA-256 must match before analysis can start."
        />
        <UAlert
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          title="Refresh-safe resume"
          description="This tab stores only the bounded upload receipt and last confirmed offset. After refresh, reselect the same file and Gemini reports the authoritative offset."
        />
        <UAlert
          color="warning"
          variant="soft"
          icon="i-lucide-shield-alert"
          title="Authorized recordings only"
          description="Use media you are authorized to process. Upload capabilities and recording content must never enter logs, run bundles, or Git."
        />
      </aside>
    </section>
  </main>
</template>
