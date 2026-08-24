<script setup lang="ts">
import type { SessionInfo } from "../../shared/types";

definePageMeta({ layout: false });
useHead({ title: "Request access · Frame of Mind" });

const { data: session, refresh } = await useFetch<SessionInfo>("/api/session", {
  headers: useRequestHeaders(["cookie"]),
});
if (!session.value?.principal) await navigateTo("/sign-in");
if (session.value?.accessState === "approved") await navigateTo("/");

const pending = ref(false);
const feedback = ref("");

async function requestAccess() {
  pending.value = true;
  feedback.value = "";
  try {
    await $fetch("/api/access/request", { method: "POST", body: {} });
    await refresh();
  } catch {
    feedback.value = "We couldn't save your request. Please wait a moment and try again.";
  } finally {
    pending.value = false;
  }
}

async function signOut() {
  await $fetch("/api/auth/sign-out", { method: "POST", body: {} });
  await navigateTo("/sign-in", { external: true });
}
</script>

<template>
  <main class="grid min-h-screen place-items-center bg-default px-4 py-12 text-highlighted">
    <UCard class="w-full max-w-lg border border-default bg-default">
      <template #header>
        <div class="space-y-2">
          <p class="text-sm font-semibold text-muted">Frame of Mind</p>
          <h1 class="text-3xl font-black tracking-tight text-highlighted">Request access</h1>
          <p class="text-sm leading-6 text-muted">
            Frame of Mind turns recordings into evidence-backed analyses. Access is approved by the maintainer before any recording can be uploaded or analyzed.
          </p>
        </div>
      </template>

      <div class="space-y-5">
        <UAlert
          v-if="session?.accessState === 'requested'"
          color="info"
          variant="soft"
          title="Request received"
          description="You'll get an email when approved. Until then, recordings, analyses, and results stay unavailable."
        />
        <UAlert
          v-else-if="session?.accessState === 'revoked'"
          color="warning"
          variant="soft"
          title="Access isn't available"
          description="This account doesn't currently have access. The maintainer can review it again."
        />
        <template v-else>
          <p class="text-sm leading-6 text-muted">
            Send one access request for <span class="font-semibold text-highlighted">{{ session?.email }}</span>. You'll get an email when approved.
          </p>
          <UButton
            block
            label="Request access"
            icon="i-lucide-send"
            :loading="pending"
            @click="requestAccess"
          />
        </template>

        <UAlert
          v-if="feedback"
          color="warning"
          variant="soft"
          title="Request not saved"
          :description="feedback"
        />
        <UButton block color="neutral" variant="ghost" label="Sign out" @click="signOut" />
      </div>
    </UCard>
  </main>
</template>
