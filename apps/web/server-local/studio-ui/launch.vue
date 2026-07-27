<script setup lang="ts">
const route = useRoute();
const invalid = computed(() => route.query.error === "invalid");

useSeoMeta({
  title: "Open Local Studio · Frame of Mind",
  description: "Exchange a one-time local Frame of Mind Studio launch link.",
});
</script>

<template>
  <main
    class="grid min-h-screen place-items-center bg-default px-6 py-12"
    data-studio-launch="local"
  >
    <UCard class="w-full max-w-xl">
      <div class="py-5 text-center">
        <div
          class="mx-auto grid size-12 place-items-center rounded-lg bg-primary text-sm font-black text-inverted"
        >
          FM
        </div>
        <h1 class="mt-5 text-3xl font-black tracking-tight">
          {{ invalid ? "Launch link expired" : "Opening private Studio…" }}
        </h1>
        <p class="mx-auto mt-3 max-w-md text-sm leading-6 text-muted">
          {{
            invalid
              ? "This one-time link is invalid or was already used. Stop Studio and launch it again to create a new private browser session."
              : "Exchanging the one-time local capability. It will be removed from the address before Studio opens."
          }}
        </p>
        <UAlert
          v-if="invalid"
          class="mt-6 text-left"
          color="warning"
          variant="soft"
          icon="i-lucide-key-round"
          title="A new launch is required"
          description="Run bun run studio again. Do not share or record the new one-time URL."
        />
        <div v-else class="mt-6 flex items-center justify-center gap-2 text-sm text-muted">
          <UIcon
            name="i-lucide-loader-circle"
            class="size-5 animate-spin"
            aria-hidden="true"
          />
          Establishing the per-launch session…
        </div>
      </div>
    </UCard>
  </main>
</template>
