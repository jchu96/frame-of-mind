<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";

const route = useRoute();
const navigation: NavigationMenuItem[] = [
  { label: "Runs", icon: "i-lucide-library", to: "/", exact: true },
  { label: "Intent", icon: "i-lucide-target", to: "/hosted/new/intent" },
  { label: "Context", icon: "i-lucide-notebook-text", to: "/hosted/new/context" },
  { label: "Recording", icon: "i-lucide-video", to: "/hosted/new/recording" },
  { label: "Run", icon: "i-lucide-play", to: "/hosted/new/run" },
  { label: "Activity", icon: "i-lucide-activity", to: "/hosted/activity" },
];
const title = computed(() => route.path.startsWith("/hosted/activity/")
  ? "Job activity"
  : route.path === "/hosted/activity"
    ? "Activity"
    : route.path.startsWith("/hosted/new/")
      ? "New hosted analysis"
      : "Runs");
</script>

<template>
  <UDashboardGroup data-hosted-studio-shell="true" storage-key="frame-of-mind-hosted-shell">
    <UDashboardSidebar id="hosted-navigation" collapsible class="bg-elevated/40">
      <template #header="{ collapsed }">
        <NuxtLink to="/" class="flex items-center gap-3">
          <span class="grid size-9 place-items-center rounded-md bg-primary text-inverted">
            <UIcon name="i-lucide-scan-eye" class="size-6" />
          </span>
          <span v-if="!collapsed" class="font-black">Frame of Mind</span>
        </NuxtLink>
      </template>
      <UNavigationMenu :items="navigation" orientation="vertical" tooltip />
      <template #footer="{ collapsed }">
        <p v-if="!collapsed" class="text-xs text-muted">Principal-bound hosted workspace</p>
      </template>
    </UDashboardSidebar>
    <UDashboardPanel id="hosted-workspace">
      <template #header>
        <UDashboardNavbar :title="title">
          <template #leading><UDashboardSidebarCollapse /></template>
          <template #right>
            <UButton v-if="!route.path.startsWith('/hosted/new/')" to="/hosted/new/intent" icon="i-lucide-plus" label="New analysis" size="sm" />
          </template>
        </UDashboardNavbar>
      </template>
      <template #body><slot /></template>
    </UDashboardPanel>
  </UDashboardGroup>
</template>
