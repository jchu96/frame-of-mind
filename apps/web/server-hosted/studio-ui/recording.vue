<script setup lang="ts">
import { loadIntentDraft } from "../../app/studio/intent-composer.js";
import { hostedStorage } from "./hosted-adapter";
import HostedComposerStepper from "./composer-stepper.vue";
import {
  hostedMediaStatusColor,
  hostedMediaStatusLabel,
  useHostedMediaUpload,
} from "./use-hosted-media-upload";
import {
  formatRetentionDuration,
  recordingFieldHelp,
  formatRecordingBytes,
  recordingDisplayLabel,
} from "../../app/studio/recording-display";

useSeoMeta({
  title: "Add a recording · Frame of Mind",
  description: "Add the recording for a hosted analysis.",
});

const { data: configuration, error } = await useFetch<{
  available: true;
  maxBytes?: number;
  sessionTtlSeconds?: number;
  retentionDays?: number;
}>("/api/hosted/media/configuration", {
  headers: useRequestHeaders(["cookie"]),
});
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });

const {
  busy, cancel, discardOpenSession, draft, fieldError, fileModel, media,
  openSessions, operationError, pause, phase, progressBytes, resumeOpenSession,
  replace, retention, start, statusMessage, totalBytes,
} = useHostedMediaUpload({ maxBytes: configuration.value?.maxBytes });
const route = useRoute();
const intentReady = ref(false);

onMounted(() => {
  intentReady.value = Boolean(loadIntentDraft(hostedStorage(sessionStorage)).draft);
});

const uploadSessionDuration = computed(() =>
  formatRetentionDuration(configuration.value?.sessionTtlSeconds ?? 0)
);
const retainedDuration = computed(() =>
  formatRetentionDuration((configuration.value?.retentionDays ?? 0) * 86_400)
);
const retentionOptions = computed(() => [
  {
    label: "Delete after analysis",
    value: "ephemeral",
    description: uploadSessionDuration.value
      ? `Delete the recording from Gemini when this analysis finishes. An unfinished upload expires after ${uploadSessionDuration.value}.`
      : "Delete the recording from Gemini when this analysis finishes.",
  },
  {
    label: retainedDuration.value
      ? `Keep for ${retainedDuration.value}`
      : "Keep until the expiry shown on the next step",
    value: "retained",
    description: retainedDuration.value
      ? `Keep a private copy for playback and evidence capture for ${retainedDuration.value}.`
      : "Keep a private copy for playback and evidence capture until the expiry shown on the next step.",
  },
]);
const fieldHelp = computed(() => recordingFieldHelp(configuration.value?.maxBytes));

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
      <UForm id="hosted-recording-form" :state="{ retention }" class="space-y-6" @submit="start">
        <header>
          <h1 class="text-4xl font-black text-highlighted">Add your recording</h1>
          <p class="mt-4 max-w-2xl text-default">
            Choose a screen recording. It goes straight from your browser to
            Gemini for analysis. If you choose Keep, the verified bytes also
            go to a private temporary copy for playback and evidence capture.
          </p>
          <UButton
            v-if="!media && !draft"
            class="mt-4"
            to="/hosted/activity"
            external
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
                Continue one after choosing the same recording, or discard it
                before starting another.
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
                <p class="font-semibold text-default">{{ formatRecordingBytes(session.declaredSizeBytes) }} recording</p>
                <p class="mt-1 text-sm text-muted">
                  <template v-if="session.retention === 'ephemeral'">
                    Delete after analysis · upload expires
                    <time :datetime="session.sessionExpiresAt" :title="session.sessionExpiresAt">{{ formatDate(session.sessionExpiresAt) }}</time>
                  </template>
                  <template v-else>
                    Keep until
                    <time :datetime="session.sessionExpiresAt" :title="session.sessionExpiresAt">{{ formatDate(session.sessionExpiresAt) }}</time>
                  </template>
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
          <div
            v-if="media"
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-default bg-elevated/50 p-4"
            data-hosted-media-ready="true"
          >
            <p class="font-semibold text-default">
              {{ recordingDisplayLabel(media, fileModel?.name || 'Recording') }}
            </p>
            <UButton type="button" color="neutral" variant="outline" size="sm" @click="replace">
              Replace
            </UButton>
          </div>
          <div v-else class="text-sm">
            <label for="hosted-recording-file" class="block font-medium text-default after:ms-0.5 after:text-error after:content-['*']">
              Screen recording
            </label>
            <p id="hosted-recording-file-description" class="text-muted">{{ fieldHelp }}</p>
            <UFileUpload
              id="hosted-recording-file"
              v-model="fileModel"
              accept=".mp4,.mov,.m4v,.webm,video/mp4,video/quicktime,video/webm"
              aria-describedby="hosted-recording-file-description"
              :aria-invalid="Boolean(fieldError)"
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
            <p v-if="fieldError" class="mt-2 text-error">{{ fieldError }}</p>
          </div>

          <fieldset
            v-if="!media"
            class="mt-6 text-sm"
            aria-describedby="hosted-retention-description"
          >
            <legend class="block font-medium text-default">After analysis</legend>
            <p id="hosted-retention-description" class="text-muted">
              Choose how long Gemini may keep this recording.
            </p>
            <div class="mt-1 flex flex-col gap-y-1">
              <label
                v-for="option in retentionOptions"
                :key="option.value"
                class="flex items-start rounded-lg border p-3.5"
                :class="retention === option.value ? 'border-primary' : 'border-muted'"
              >
                <input
                  v-model="retention"
                  type="radio"
                  name="retention"
                  :value="option.value"
                  :disabled="busy || Boolean(draft) || Boolean(media) || openSessions.length > 0"
                  class="mt-0.5 size-4 accent-primary"
                />
                <span class="ms-2 w-full">
                  <span class="block font-medium text-default">{{ option.label }}</span>
                  <span class="block text-muted">{{ option.description }}</span>
                </span>
              </label>
            </div>
          </fieldset>
        </UCard>

        <UCard v-if="phase !== 'idle' && !media">
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h2 class="text-xl font-black text-highlighted">Upload progress</h2>
              <UBadge
                role="status"
                :color="hostedMediaStatusColor(phase)"
                variant="soft"
              >
                {{ hostedMediaStatusLabel(phase) }}
              </UBadge>
            </div>
          </template>

          <p aria-live="polite" class="font-semibold text-default">{{ statusMessage }}</p>
          <p v-if="media?.keptUntil" class="mt-2 text-sm text-muted" data-hosted-kept-until>
            Private copy kept until {{ new Date(media.keptUntil).toLocaleString() }} unless you delete it sooner.
          </p>
          <div v-if="totalBytes" class="mt-5">
            <UProgress
              :model-value="progressBytes"
              :max="totalBytes"
              size="lg"
              aria-label="Recording upload progress"
            />
            <p class="mt-2 text-sm text-muted">
              {{ formatRecordingBytes(progressBytes) }} of {{ formatRecordingBytes(totalBytes) }}
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
          </div>
        </UCard>
        <UButton v-if="media" to="/hosted/new/run" external trailing-icon="i-lucide-arrow-right">
          Continue
        </UButton>
      </UForm>

      <aside aria-label="Recording privacy details">
        <UAlert
          color="primary"
          variant="soft"
          icon="i-lucide-shield-check"
          title="Private by design"
          description="Your browser receives write-only upload access, never the Gemini API key. Upload only recordings you are allowed to process; recordings and upload addresses are never stored in logs or run bundles."
        />
        <UAlert
          color="neutral"
          variant="outline"
          icon="i-lucide-image-off"
          title="Delete-after-analysis review limits"
          description="Delete-after-analysis runs have no playback or screenshot capture after this tab closes. Those features require a temporary private copy or the exact same recording."
        />
      </aside>
    </section>
  </main>
</template>
