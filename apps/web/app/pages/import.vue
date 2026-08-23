<script setup lang="ts">
useSeoMeta({ title: "Import run · Frame of Mind" });

const analysis = ref<File>();
const manifest = ref<File>();
const busy = ref(false);
const success = ref<{ runId: string; created: boolean }>();
const failure = ref("");

function selectFile(target: "analysis" | "manifest", event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (target === "analysis") analysis.value = file;
  else manifest.value = file;
}

async function importRun() {
  if (!analysis.value || !manifest.value) return;
  busy.value = true;
  failure.value = "";
  success.value = undefined;
  try {
    const [analysisJson, manifestJson] = await Promise.all([
      analysis.value.text().then(JSON.parse),
      manifest.value.text().then(JSON.parse),
    ]);
    success.value = await $fetch("/api/runs", {
      method: "POST",
      body: { analysis: analysisJson, manifest: manifestJson },
    });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : "Import failed.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <AppHeader />
    <main class="fom-shell py-10 sm:py-14">
      <div class="mx-auto max-w-3xl">
        <p class="fom-kicker text-primary">Import analysis files</p>
        <h1 class="mt-4 text-4xl font-black tracking-[-0.04em] sm:text-5xl">Import a reviewed run.</h1>
        <p class="mt-4 max-w-2xl leading-7 text-muted">
          Select the matching files from one Frame of Mind analysis. We check that they belong
          together and have not changed before saving the results.
        </p>

        <div class="fom-panel mt-8 p-6 sm:p-8">
          <form class="space-y-6" @submit.prevent="importRun">
            <div>
              <label for="analysis-file" class="block text-sm font-bold">
                analysis.json
              </label>
              <span id="analysis-file-description" class="mt-1 block text-xs text-dimmed">
                Structured analysis records; no raw transcript.
              </span>
              <input
                id="analysis-file"
                type="file"
                aria-describedby="analysis-file-description"
                accept="application/json,.json"
                required
                class="mt-3 block w-full border border-default bg-default p-3 text-sm file:mr-4 file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:font-bold"
                @change="selectFile('analysis', $event)"
              >
            </div>

            <div>
              <label for="manifest-file" class="block text-sm font-bold">
                manifest.json
              </label>
              <span id="manifest-file-description" class="mt-1 block text-xs text-dimmed">
                How the analysis was produced and how its recording was handled.
              </span>
              <input
                id="manifest-file"
                type="file"
                aria-describedby="manifest-file-description"
                accept="application/json,.json"
                required
                class="mt-3 block w-full border border-default bg-default p-3 text-sm file:mr-4 file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:font-bold"
                @change="selectFile('manifest', $event)"
              >
            </div>

            <UAlert
              color="neutral"
              variant="soft"
              title="Not imported"
              description="Recording files, screenshots, provider payloads, and full transcripts remain on the source machine."
            />

            <div class="flex flex-wrap items-center gap-3">
              <UButton type="submit" :loading="busy" :disabled="!analysis || !manifest">
                Validate and import
              </UButton>
              <UButton to="/" color="neutral" variant="ghost">Cancel</UButton>
            </div>
          </form>
        </div>

        <UAlert
          v-if="success"
          class="mt-5"
          color="success"
          variant="soft"
          title="Run imported"
          :description="success.created ? 'The results were saved.' : 'The saved results were updated.'"
        >
          <template #actions>
            <UButton :to="`/runs/${encodeURIComponent(success.runId)}`" size="sm">Open run</UButton>
          </template>
        </UAlert>
        <UAlert
          v-if="failure"
          class="mt-5"
          color="error"
          variant="soft"
          title="Import failed"
          :description="failure"
        />
      </div>
    </main>
  </div>
</template>
