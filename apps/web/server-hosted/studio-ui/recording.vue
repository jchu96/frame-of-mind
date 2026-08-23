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
  formatRecordingBytes,
  recordingDisplayLabel,
} from "../../app/studio/recording-display";

useSeoMeta({
  title: "Add a recording · Frame of Mind",
  description: "Add the recording for a hosted analysis.",
});

const { data: configuration, error } = await useFetch<{ available: true; maxBytes: number }>("/api/hosted/media/configuration", {
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

const retentionOptions = [
  {
    label: "Delete after analysis",
    value: "ephemeral",
    description: "Delete the recording from Gemini when this analysis finishes.",
  },
  {
    label: "Keep for 7 days",
    value: "retained",
    description: "Keep the recording in Gemini for up to 7 days.",
  },
];
const fieldHelp = computed(() =>
  `MP4, MOV, M4V or WebM, up to ${formatRecordingBytes(configuration.value?.maxBytes ?? 0)}`
);

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
            Choose a screen recording. It goes straight from your browser to
            Gemini for analysis; Frame of Mind never stores the video.
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
                  <template v-if="session.retention === 'ephemeral'">Delete after analysis</template><template v-else>Keep for 7 days</template>
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
          <UFormField
            v-else
            label="Screen recording"
            :description="fieldHelp"
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
            v-if="!media"
            class="mt-6"
            name="retention"
            label="After analysis"
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
        <UButton v-if="media" to="/hosted/new/run" trailing-icon="i-lucide-arrow-right">
          Continue
        </UButton>
      </UForm>

      <aside aria-label="Recording privacy details">
        <UAlert
          color="primary"
          variant="soft"
          icon="i-lucide-shield-check"
          title="Private by design"
          description="Your recording goes directly to Gemini. Upload only recordings you are allowed to process; Frame of Mind never stores the video or includes it in your results."
        />
      </aside>
    </section>
  </main>
</template>
