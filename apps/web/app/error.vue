<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{ error: NuxtError }>();
const config = useRuntimeConfig();
const missing = computed(() => props.error.statusCode === 404);

useSeoMeta({
  title: () => `${missing.value ? "Not found" : "Something went wrong"} · Frame of Mind`,
});
</script>

<template>
  <UApp>
    <main class="grid min-h-screen place-items-center bg-default p-6">
      <UCard class="w-full max-w-lg text-center">
        <UIcon :name="missing ? 'i-lucide-search-x' : 'i-lucide-triangle-alert'" class="mx-auto size-10 text-primary" />
        <p class="fom-kicker mt-5 text-primary">{{ error.statusCode }}</p>
        <h1 class="mt-3 text-3xl font-black">
          {{ missing ? "We couldn't find that analysis" : "Something went wrong" }}
        </h1>
        <p class="mt-3 text-muted">
          {{ missing ? "It may have been removed, or it may belong to another account." : "Try the page again or return to your results." }}
        </p>
        <div class="mt-6 flex flex-wrap justify-center gap-3">
          <UButton :to="config.public.hostedStudioEnabled ? '/hosted/activity' : '/'" label="Activity" />
          <UButton v-if="config.public.hostedStudioEnabled" to="/hosted/new/intent" color="neutral" variant="outline" label="New analysis" />
        </div>
      </UCard>
    </main>
  </UApp>
</template>
