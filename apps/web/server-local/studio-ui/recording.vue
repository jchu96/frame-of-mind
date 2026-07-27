<script setup lang="ts">
import { useMediaStaging } from "./use-media-staging";

useSeoMeta({
  title: "Recording · Frame of Mind",
  description: "Stage one recording privately in local Frame of Mind Studio.",
});

const {
  abortStaging,
  busy,
  fileModel,
  fieldError,
  hasActiveSession,
  operationError,
  pause,
  phase,
  progressBytes,
  restart,
  resume,
  retentionMode,
  retentionTtlSeconds,
  selectedFile,
  session,
  start,
  statusMessage,
  totalBytes,
} = useMediaStaging();

const retentionOptions = [
  {
    label: "Ephemeral",
    value: "ephemeral",
    description: "Delete after a future analysis finishes or the upload expires.",
  },
  {
    label: "Retained",
    value: "retained",
    description: "Keep a private local copy for timestamp-linked review.",
  },
];
const retainedLifetimeOptions = [
  { label: "1 hour", value: 60 * 60 },
  { label: "1 day", value: 24 * 60 * 60 },
  { label: "7 days", value: 7 * 24 * 60 * 60 },
];

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1_024)),
    units.length - 1,
  );
  const value = bytes / 1_024 ** unit;
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "Not applicable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
</script>

<template>
  <div>
    <AppHeader />
    <main class="fom-shell py-10 sm:py-14">
      <section class="grid gap-8 lg:grid-cols-[1fr_0.6fr] lg:items-end">
        <div>
          <p class="fom-kicker text-emerald-700">Local Studio · Recording</p>
          <h1 class="mt-4 text-4xl font-black tracking-[-0.045em] sm:text-6xl">
            Put one recording in the frame.
          </h1>
          <p class="mt-5 max-w-3xl text-base leading-7 text-zinc-600 sm:text-lg">
            Choose or drop an authorized screen recording. Nothing leaves this
            machine when you select it, and progress counts only parts the
            local server has durably confirmed.
          </p>
        </div>
        <UAlert
          color="neutral"
          variant="soft"
          icon="i-lucide-hard-drive"
          title="Private local staging"
          description="Bytes go to your operating system's private application-data directory, outside this Git checkout."
        />
      </section>

      <section class="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="space-y-6">
          <UCard>
            <template #header>
              <div>
                <p class="fom-kicker text-zinc-500">1 · Recording</p>
                <h2 class="mt-2 text-2xl font-black">Choose the visual source</h2>
              </div>
            </template>

            <UFormField
              label="Screen recording"
              description="MP4, MOV, M4V, or WebM; one file; 2 GB maximum."
              :error="fieldError"
              required
            >
              <UFileUpload
                v-model="fileModel"
                accept=".mp4,.mov,.m4v,.webm,video/mp4,video/quicktime,video/webm"
                label="Drop a recording here"
                description="or press Enter to choose from this computer"
                icon="i-lucide-video"
                layout="list"
                position="inside"
                :multiple="false"
                :disabled="busy"
                :file-image="false"
                class="min-h-52 w-full"
                :ui="{ base: 'min-h-52' }"
              >
                <template #actions="{ open }">
                  <UButton
                    type="button"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-folder-open"
                    :disabled="busy"
                    @click.stop="open()"
                  >
                    Choose recording
                  </UButton>
                </template>
              </UFileUpload>
            </UFormField>

            <dl
              v-if="selectedFile"
              class="mt-5 grid gap-3 border-t border-default pt-5 text-sm sm:grid-cols-2"
            >
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">Selected</dt>
                <dd class="mt-1 break-all font-semibold">{{ selectedFile.name }}</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">Size</dt>
                <dd class="mt-1 font-semibold">{{ formatBytes(selectedFile.size) }}</dd>
              </div>
            </dl>
          </UCard>

          <UCard>
            <template #header>
              <div>
                <p class="fom-kicker text-zinc-500">2 · Retention</p>
                <h2 class="mt-2 text-2xl font-black">Choose how long local media lasts</h2>
              </div>
            </template>

            <UFormField
              label="Local recording retention"
              description="This choice is locked after staging begins."
            >
              <URadioGroup
                v-model="retentionMode"
                :items="retentionOptions"
                variant="card"
                :disabled="Boolean(session)"
              />
            </UFormField>

            <UFormField
              v-if="retentionMode === 'retained'"
              class="mt-5"
              label="Retained lifetime"
              description="Expired copies are deleted by local reconciliation."
            >
              <USelect
                v-model="retentionTtlSeconds"
                :items="retainedLifetimeOptions"
                value-key="value"
                label-key="label"
                class="w-full sm:max-w-xs"
                :disabled="Boolean(session)"
              />
            </UFormField>
          </UCard>

          <UCard v-if="session || phase !== 'idle'">
            <template #header>
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p class="fom-kicker text-zinc-500">3 · Local staging</p>
                  <h2 class="mt-2 text-2xl font-black">Durable upload receipt</h2>
                </div>
                <UBadge
                  role="status"
                  :color="phase === 'sealed'
                    ? 'success'
                    : phase === 'failed' || phase === 'mismatch'
                      ? 'error'
                      : phase === 'paused' || phase === 'reselect-required'
                        ? 'warning'
                        : 'primary'"
                  variant="soft"
                >
                  {{ phase.replaceAll('-', ' ') }}
                </UBadge>
              </div>
            </template>

            <div aria-live="polite" aria-atomic="true">
              <p class="font-semibold">{{ statusMessage }}</p>
            </div>

            <div v-if="session" class="mt-5">
              <UProgress
                :model-value="progressBytes"
                :max="totalBytes || 1"
                size="lg"
                aria-label="Confirmed local upload progress"
              />
              <p class="mt-2 text-sm text-zinc-600">
                {{ formatBytes(progressBytes) }} of
                {{ formatBytes(totalBytes) }} confirmed locally
              </p>
            </div>

            <UAlert
              v-if="operationError"
              class="mt-5"
              color="error"
              variant="soft"
              icon="i-lucide-triangle-alert"
              title="Staging needs attention"
              :description="operationError"
            />

            <dl
              v-if="session"
              class="mt-5 grid gap-4 border-t border-default pt-5 text-sm sm:grid-cols-2"
            >
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">Storage</dt>
                <dd class="mt-1">Private per-user application data</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">Upload expires</dt>
                <dd class="mt-1">{{ formatDate(session.uploadExpiresAt) }}</dd>
              </div>
              <div v-if="session.retention.mode === 'retained'">
                <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">Retained until</dt>
                <dd class="mt-1">{{ formatDate(session.retention.expiresAt) }}</dd>
              </div>
              <div>
                <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">Server state</dt>
                <dd class="mt-1">{{ session.status.replaceAll('_', ' ') }}</dd>
              </div>
            </dl>

            <div class="mt-6 flex flex-wrap gap-3">
              <UButton
                v-if="phase === 'selected' || (phase === 'failed' && !session)"
                type="button"
                icon="i-lucide-hard-drive-upload"
                :disabled="!selectedFile"
                @click="start"
              >
                {{ phase === 'failed' ? 'Retry staging' : 'Stage locally' }}
              </UButton>
              <UButton
                v-if="phase === 'uploading' || phase === 'verifying' || phase === 'sealing'"
                type="button"
                color="neutral"
                variant="outline"
                icon="i-lucide-pause"
                @click="pause"
              >
                Pause
              </UButton>
              <UButton
                v-if="phase === 'paused' || phase === 'ready-to-resume' || (phase === 'failed' && hasActiveSession)"
                type="button"
                icon="i-lucide-play"
                :disabled="!selectedFile"
                @click="resume"
              >
                {{ phase === 'failed' ? 'Retry from confirmed parts' : 'Resume' }}
              </UButton>
              <UButton
                v-if="phase === 'mismatch'"
                type="button"
                color="warning"
                icon="i-lucide-rotate-ccw"
                @click="restart"
              >
                Delete old upload and restart
              </UButton>
              <UButton
                v-if="session && !['aborted', 'deleted'].includes(session.status)"
                type="button"
                color="error"
                variant="soft"
                icon="i-lucide-trash-2"
                :loading="phase === 'aborting'"
                @click="abortStaging"
              >
                Delete staged copy
              </UButton>
            </div>
          </UCard>
        </div>

        <aside class="space-y-5" aria-label="Recording privacy details">
          <UAlert
            color="primary"
            variant="soft"
            icon="i-lucide-cloud-upload"
            title="Gemini transfer happens later"
            description="Selecting or staging does not contact Gemini. A future analysis action will explicitly upload a temporary copy to Gemini Files and report cleanup."
          />
          <UAlert
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            title="Refresh-safe, file-private"
            description="Only an opaque upload ID survives a page refresh. The browser forgets the File object and asks you to reselect it before verified resume."
          />
          <UAlert
            color="warning"
            variant="soft"
            icon="i-lucide-shield-alert"
            title="Authorized recordings only"
            description="Recordings and generated understanding can be sensitive. Use media you are authorized to process and do not move staged data into Git."
          />
          <UButton
            to="/connections"
            block
            color="neutral"
            variant="outline"
            icon="i-lucide-plug"
          >
            Review connections
          </UButton>
        </aside>
      </section>
    </main>
  </div>
</template>
