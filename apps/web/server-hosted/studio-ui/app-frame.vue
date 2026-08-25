<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";
import type { SessionInfo } from "../../shared/types";

const route = useRoute();
const toast = useToast();
const signInRoute = computed(() => route.path === "/sign-in");
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
function followHostedLink(event: MouseEvent, to: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void navigateTo(to);
}
const navigation = computed<NavigationMenuItem[]>(() => [
  {
    label: "New analysis",
    icon: "i-lucide-plus",
    to: "/hosted/new/intent",
    external: true,
    active: route.path.startsWith("/hosted/new/"),
    onClick: (event: MouseEvent) => followHostedLink(event, "/hosted/new/intent"),
  },
  {
    label: "Activity",
    icon: "i-lucide-activity",
    to: "/hosted/activity",
    external: true,
    active: route.path.startsWith("/hosted/activity"),
    onClick: (event: MouseEvent) => followHostedLink(event, "/hosted/activity"),
  },
  {
    label: "Results",
    icon: "i-lucide-library",
    to: "/",
    external: true,
    active: route.path === "/" || route.path.startsWith("/review/") || route.path.startsWith("/runs/"),
    onClick: (event: MouseEvent) => followHostedLink(event, "/"),
  },
  ...(session.value?.maintainer
    ? [{
        label: "Access",
        icon: "i-lucide-shield-check",
        to: "/admin/access",
        external: true,
        active: route.path === "/admin/access",
        onClick: (event: MouseEvent) => followHostedLink(event, "/admin/access"),
      }]
    : []),
]);

async function signOut(): Promise<void> {
  if (session.value?.authMode.includes("better-auth")) {
    try {
      await $fetch("/api/auth/sign-out", { method: "POST", body: {} });
      await navigateTo("/sign-in", { external: true });
    } catch {
      toast.add({
        title: "Could not sign out",
        description: "Try again. Your session is still active.",
        color: "error",
      });
    }
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
        <a href="/" class="flex items-center gap-3" @click="followHostedLink($event, '/')">
          <span class="grid size-9 place-items-center rounded-md bg-primary text-inverted">
            <UIcon name="i-lucide-scan-eye" class="size-6" />
          </span>
          <span v-if="!collapsed" class="font-black">Frame of Mind</span>
        </a>
      </template>
      <UNavigationMenu data-hosted-navigation :items="navigation" orientation="vertical" tooltip />
      <template #footer="{ collapsed }">
        <div v-if="!collapsed" class="space-y-2 text-xs">
          <p class="flex min-w-0 items-center gap-1 text-muted">
            <span class="truncate">{{ session?.email || "Your account" }}</span>
            <span aria-hidden="true">·</span>
            <button type="button" class="shrink-0 font-bold text-primary hover:underline" @click="signOut">Sign out</button>
          </p>
          <a href="/import" class="text-muted hover:text-highlighted hover:underline" @click="followHostedLink($event, '/import')">Import a run</a>
        </div>
      </template>
    </UDashboardSidebar>
    <UDashboardPanel id="hosted-workspace">
      <template #header>
        <UDashboardNavbar>
          <template #left>
            <UDashboardSidebarCollapse />
            <p class="sr-only">{{ title }}</p>
          </template>
          <template #right>
            <UButton v-if="!route.path.startsWith('/hosted/new/')" to="/hosted/new/intent" external icon="i-lucide-plus" label="New analysis" size="sm" />
          </template>
        </UDashboardNavbar>
      </template>
      <template #body><div id="hosted-main"><slot /></div></template>
    </UDashboardPanel>
  </UDashboardGroup>
  </template>
</template>
