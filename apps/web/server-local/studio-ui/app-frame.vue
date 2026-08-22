<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";

const route = useRoute();
const launchRoute = computed(() => route.path === "/__studio/launch");
const navigation: NavigationMenuItem[] = [
  {
    label: "Home",
    icon: "i-lucide-house",
    to: "/",
    exact: true,
  },
  {
    label: "Intent",
    icon: "i-lucide-target",
    to: "/intent",
  },
  {
    label: "Context",
    icon: "i-lucide-notebook-text",
    to: "/context",
  },
  {
    label: "Recording",
    icon: "i-lucide-video",
    to: "/recording",
  },
  {
    label: "Run",
    icon: "i-lucide-play",
    to: "/run",
  },
  {
    label: "Connections",
    icon: "i-lucide-plug-zap",
    to: "/connections",
  },
  {
    label: "Import run",
    icon: "i-lucide-file-up",
    to: "/import",
  },
];
const title = computed(() => {
  if (route.path === "/") return "Home";
  if (route.path === "/recording") return "Recording";
  if (route.path === "/context") return "Context";
  if (route.path === "/intent") return "Intent";
  if (route.path === "/run") return "Run receipt";
  if (route.path === "/connections") return "Connections";
  if (route.path === "/import") return "Import run";
  if (route.path.startsWith("/runs/")) return "Run detail";
  return "Local Studio";
});
</script>

<template>
  <slot v-if="launchRoute" />
  <UDashboardGroup
    v-else
    data-studio-shell="local"
    storage-key="frame-of-mind-studio-shell"
    unit="rem"
  >
    <UDashboardSidebar
      id="studio-navigation"
      collapsible
      resizable
      class="bg-elevated/40"
      aria-label="Studio navigation"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          to="/"
          class="flex min-w-0 items-center gap-3"
          aria-label="Frame of Mind Studio home"
        >
          <span
            class="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-inverted"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 64 64"
              fill="none"
              stroke="currentColor"
              stroke-width="6"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="size-7"
              role="img"
              aria-label="Frame of Mind"
            >
              <path d="M10 24V16a6 6 0 0 1 6-6h8" />
              <path d="M40 10h8a6 6 0 0 1 6 6v8" />
              <path d="M54 40v8a6 6 0 0 1-6 6h-8" />
              <path d="M24 54h-8a6 6 0 0 1-6-6v-8" />
              <circle cx="37" cy="27" r="5" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <span v-if="!collapsed" class="min-w-0">
            <span class="block truncate text-sm font-black text-highlighted">
              Frame of Mind
            </span>
            <span class="block truncate text-xs text-muted">Studio</span>
          </span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          :items="navigation"
          orientation="vertical"
          :collapsed="collapsed"
          tooltip
          aria-label="Studio navigation"
          :ui="{ link: collapsed ? 'justify-center' : undefined }"
        />
      </template>

      <template #footer="{ collapsed }">
        <div
          class="flex items-center gap-3"
          :class="collapsed ? 'justify-center' : undefined"
        >
          <UIcon
            name="i-lucide-shield-check"
            class="size-5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div v-if="!collapsed" class="min-w-0">
            <p class="truncate text-xs font-bold text-highlighted">Private local process</p>
            <p class="truncate text-xs text-muted">Session protected</p>
          </div>
        </div>
      </template>
    </UDashboardSidebar>

    <UDashboardPanel id="studio-workspace">
      <template #header>
        <UDashboardNavbar :title="title">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
          <template #right>
            <UButton
              v-if="route.path !== '/'"
              to="/intent"
              icon="i-lucide-plus"
              label="New analysis"
              size="sm"
            />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <slot />
      </template>
    </UDashboardPanel>
  </UDashboardGroup>
</template>
