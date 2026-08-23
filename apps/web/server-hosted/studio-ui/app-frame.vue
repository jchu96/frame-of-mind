<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";
import type { SessionInfo } from "../../shared/types";

const route = useRoute();
const signInRoute = computed(() => route.path === "/sign-in");
const navigation: NavigationMenuItem[] = [
  { label: "New analysis", icon: "i-lucide-plus", to: "/hosted/new/intent" },
  { label: "Activity", icon: "i-lucide-activity", to: "/hosted/activity" },
  { label: "Results", icon: "i-lucide-library", to: "/", exact: true },
];
const title = computed(() => route.path.startsWith("/hosted/activity/")
  ? "Activity"
  : route.path === "/hosted/activity"
    ? "Activity"
    : route.path.startsWith("/hosted/new/")
      ? "New analysis"
      : route.path.startsWith("/review/") || route.path.startsWith("/runs/")
        ? "Results"
        : "Results");
const { data: session } = await useFetch<SessionInfo>("/api/session");

async function signOut(): Promise<void> {
  if (session.value?.authMode.includes("better-auth")) {
    await $fetch("/api/auth/sign-out", { method: "POST" });
    await navigateTo("/sign-in", { external: true });
    return;
  }
  await navigateTo("/cdn-cgi/access/logout", { external: true });
}
</script>

<template>
  <slot v-if="signInRoute" />
  <template v-else>
  <a href="#hosted-main" class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-default focus:px-4 focus:py-2 focus:text-highlighted focus:ring-2 focus:ring-primary">
    Skip to content
  </a>
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
        <div v-if="!collapsed" class="space-y-2 text-xs">
          <p class="truncate text-muted">{{ session?.email || "Your account" }}</p>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" class="font-bold text-primary hover:underline" @click="signOut">Sign out</button>
            <NuxtLink to="/import" class="text-muted hover:text-highlighted hover:underline">Import a run</NuxtLink>
          </div>
        </div>
      </template>
    </UDashboardSidebar>
    <UDashboardPanel id="hosted-workspace">
      <template #header>
        <UDashboardNavbar>
          <template #leading><UDashboardSidebarCollapse /></template>
          <template #title><p class="font-bold text-highlighted">{{ title }}</p></template>
          <template #right>
            <UButton v-if="!route.path.startsWith('/hosted/new/')" to="/hosted/new/intent" icon="i-lucide-plus" label="New analysis" size="sm" />
          </template>
        </UDashboardNavbar>
      </template>
      <template #body><div id="hosted-main"><slot /></div></template>
    </UDashboardPanel>
  </UDashboardGroup>
  </template>
</template>
