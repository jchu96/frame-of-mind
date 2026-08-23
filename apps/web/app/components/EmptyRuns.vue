<script setup lang="ts">
const config = useRuntimeConfig();
</script>

<template>
  <div class="fom-panel px-6 py-14 text-center">
    <p class="fom-kicker text-primary">No results yet</p>
    <h2 class="mt-3 text-2xl font-black tracking-tight">
      {{ config.public.hostedStudioEnabled ? "Start your first analysis" : "Add your first finished analysis" }}
    </h2>
    <p class="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted">
      <template v-if="config.public.hostedStudioEnabled">
        Choose what to find, add a recording, and your results will appear here when the analysis finishes.
      </template>
      <template v-else>
        Import an <code>analysis.json</code> and its matching <code>manifest.json</code> to make the run browsable here.
      </template>
    </p>
    <div class="mt-6 flex flex-wrap justify-center gap-3">
      <UButton v-if="config.public.hostedStudioEnabled" to="/hosted/new/intent">Start an analysis</UButton>
      <UButton to="/import" :color="config.public.hostedStudioEnabled ? 'neutral' : 'primary'" :variant="config.public.hostedStudioEnabled ? 'outline' : 'solid'">Import a run</UButton>
    </div>
  </div>
</template>
