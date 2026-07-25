<template>
  <div class="fom-panel px-6 py-14 text-center">
    <p class="fom-kicker text-emerald-700">No projections yet</p>
    <h2 class="mt-3 text-2xl font-black tracking-tight">Your run bundles are still the source of truth.</h2>
    <p class="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-600">
      Import an <code>analysis.json</code> and its matching <code>manifest.json</code>
      to make the run browsable here. Recordings, screenshots, and transcripts are not uploaded.
    </p>
    <UButton to="/import" class="mt-6">Import a run</UButton>
  </div>
</template>
