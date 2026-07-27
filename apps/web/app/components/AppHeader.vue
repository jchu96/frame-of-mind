<script setup lang="ts">
import type { SessionInfo } from "../../shared/types";

const { data: session } = await useFetch<SessionInfo>("/api/session");
const config = useRuntimeConfig();
</script>

<template>
  <header class="border-b border-zinc-300/80 bg-[#f6f4ed]/90 backdrop-blur">
    <div
      class="fom-shell flex min-h-18 flex-col items-stretch gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <NuxtLink to="/" class="group flex items-center gap-3" aria-label="Frame of Mind home">
        <span
          class="grid size-10 place-items-center border border-zinc-900 bg-zinc-950 text-sm font-black text-emerald-300 transition-transform group-hover:-rotate-3"
        >
          FM
        </span>
        <span>
          <span class="block text-sm font-black tracking-tight">Frame of Mind</span>
          <span class="block text-xs text-zinc-500">Video in. Understanding out.</span>
        </span>
      </NuxtLink>

      <nav
        class="flex items-center justify-between gap-2 sm:justify-end"
        aria-label="Primary navigation"
      >
        <UButton to="/" color="neutral" variant="ghost" size="sm">Runs</UButton>
        <UButton
          v-if="config.public.studioEnabled"
          to="/recording"
          color="primary"
          variant="soft"
          size="sm"
          icon="i-lucide-video"
          aria-label="Stage a recording"
        >
          <span class="hidden sm:inline">Recording</span>
        </UButton>
        <UButton
          v-if="config.public.studioEnabled"
          to="/connections"
          color="neutral"
          variant="ghost"
          size="sm"
        >
          Connections
        </UButton>
        <UButton to="/import" color="primary" variant="soft" size="sm">Import run</UButton>
        <UBadge
          color="neutral"
          variant="outline"
          class="hidden max-w-52 truncate sm:inline-flex"
        >
          {{ session?.email || (session?.authMode === "cloudflare-access" ? "Access" : "Local only") }}
        </UBadge>
      </nav>
    </div>
  </header>
</template>
