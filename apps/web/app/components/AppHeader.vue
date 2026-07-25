<script setup lang="ts">
import type { SessionInfo } from "../../shared/types";

const { data: session } = await useFetch<SessionInfo>("/api/session");
</script>

<template>
  <header class="border-b border-zinc-300/80 bg-[#f6f4ed]/90 backdrop-blur">
    <div class="fom-shell flex min-h-18 items-center justify-between gap-4">
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

      <nav class="flex items-center gap-2" aria-label="Primary navigation">
        <UButton to="/" color="neutral" variant="ghost" size="sm">Runs</UButton>
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
