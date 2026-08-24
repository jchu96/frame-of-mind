<script setup lang="ts">
import type { SessionInfo } from "../../../shared/types";
import type {
  AdminAccessAction,
  AdminAccessGroups,
  AdminAccessRow,
} from "#frame-admin-access";
import { adminAccessErrorSentence } from "#frame-admin-access";

useHead({ title: "Access administration · Frame of Mind" });

const emptyGroups = (): AdminAccessGroups => ({ requested: [], approved: [], revoked: [] });
const { data: session } = await useFetch<SessionInfo>("/api/session", {
  headers: useRequestHeaders(["cookie"]),
});
const { data, error, refresh } = await useFetch<AdminAccessGroups>("/api/admin/access", {
  headers: useRequestHeaders(["cookie"]),
});
const groups = computed(() => data.value ?? emptyGroups());
const confirming = ref("");
const pending = ref("");
const feedback = ref(error.value
  ? adminAccessErrorSentence(errorCode(error.value))
  : "");

function confirmationKey(action: AdminAccessAction, email: string): string {
  return `${action}:${email}`;
}

async function act(action: AdminAccessAction, row: AdminAccessRow): Promise<void> {
  const key = confirmationKey(action, row.email);
  if ((action === "deny" || action === "revoke") && confirming.value !== key) {
    confirming.value = key;
    return;
  }
  pending.value = key;
  feedback.value = "";
  try {
    await $fetch(`/api/admin/access/${action}`, {
      method: "POST",
      body: { email: row.email },
    });
    confirming.value = "";
    await refresh();
  } catch (actionError) {
    feedback.value = adminAccessErrorSentence(errorCode(actionError));
  } finally {
    pending.value = "";
  }
}

function errorCode(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const nested = (data as { data?: unknown }).data;
  if (nested && typeof nested === "object" && "code" in nested) {
    return (nested as { code?: unknown }).code;
  }
  return "code" in data ? (data as { code?: unknown }).code : undefined;
}

function dateLabel(value: string | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Recorded";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function revokeWhy(row: AdminAccessRow): string {
  if (row.email === session.value?.email) return "Sign in as another maintainer to revoke your own access.";
  if (groups.value.approved.length <= 1) return "The last approved member cannot be revoked.";
  return "";
}
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-8 py-2">
    <div class="space-y-2">
      <p class="text-sm font-semibold text-primary">Administration</p>
      <h1 class="text-3xl font-black tracking-tight text-highlighted">Access</h1>
      <p class="max-w-2xl text-sm leading-6 text-muted">
        Review requests and membership. Approvals change access only; Frame of Mind does not email the requester.
      </p>
    </div>

    <UAlert
      v-if="feedback"
      color="error"
      variant="soft"
      title="Access action not completed"
      :description="feedback"
    />

    <section class="space-y-3" aria-labelledby="pending-heading">
      <div class="flex items-baseline justify-between gap-4">
        <h2 id="pending-heading" class="text-xl font-black text-highlighted">Pending</h2>
        <span class="text-sm text-muted">{{ groups.requested.length }}</span>
      </div>
      <UCard v-if="groups.requested.length" class="border border-default bg-default">
        <ul class="divide-y divide-default">
          <li v-for="row in groups.requested" :key="row.email" class="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <p class="truncate font-semibold text-highlighted">{{ row.email }}</p>
              <p class="text-sm text-muted">Requested {{ dateLabel(row.invited_at) }}</p>
            </div>
            <div v-if="confirming === confirmationKey('deny', row.email)" class="flex flex-wrap items-center gap-2">
              <span class="text-sm text-muted">Deny this request?</span>
              <UButton color="error" variant="soft" size="sm" label="Confirm deny" :loading="pending === confirmationKey('deny', row.email)" @click="act('deny', row)" />
              <UButton color="neutral" variant="ghost" size="sm" label="Cancel" @click="confirming = ''" />
            </div>
            <div v-else class="flex gap-2">
              <UButton size="sm" label="Approve" :loading="pending === confirmationKey('approve', row.email)" @click="act('approve', row)" />
              <UButton color="neutral" variant="soft" size="sm" label="Deny" @click="act('deny', row)" />
            </div>
          </li>
        </ul>
      </UCard>
      <UCard v-else class="border border-default bg-default">
        <p class="text-sm text-muted">No access requests are waiting for review.</p>
      </UCard>
    </section>

    <section class="space-y-3" aria-labelledby="members-heading">
      <div class="flex items-baseline justify-between gap-4">
        <h2 id="members-heading" class="text-xl font-black text-highlighted">Members</h2>
        <span class="text-sm text-muted">{{ groups.approved.length }}</span>
      </div>
      <UCard v-if="groups.approved.length" class="border border-default bg-default">
        <ul class="divide-y divide-default">
          <li v-for="row in groups.approved" :key="row.email" class="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <p class="truncate font-semibold text-highlighted">{{ row.email }}</p>
              <p class="text-sm text-muted">Approved {{ dateLabel(row.approved_at) }}</p>
              <p v-if="revokeWhy(row)" class="mt-1 text-xs text-muted">{{ revokeWhy(row) }}</p>
            </div>
            <div v-if="confirming === confirmationKey('revoke', row.email)" class="flex flex-wrap items-center gap-2">
              <span class="text-sm text-muted">Revoke this member?</span>
              <UButton color="error" variant="soft" size="sm" label="Confirm revoke" :loading="pending === confirmationKey('revoke', row.email)" @click="act('revoke', row)" />
              <UButton color="neutral" variant="ghost" size="sm" label="Cancel" @click="confirming = ''" />
            </div>
            <UButton v-else color="neutral" variant="soft" size="sm" label="Revoke" :disabled="Boolean(revokeWhy(row))" @click="act('revoke', row)" />
          </li>
        </ul>
      </UCard>
      <UCard v-else class="border border-default bg-default">
        <p class="text-sm text-muted">No approved members are present. Use the CLI to recover access.</p>
      </UCard>
    </section>

    <section class="space-y-3" aria-labelledby="revoked-heading">
      <div class="flex items-baseline justify-between gap-4">
        <h2 id="revoked-heading" class="text-xl font-black text-highlighted">Revoked</h2>
        <span class="text-sm text-muted">{{ groups.revoked.length }}</span>
      </div>
      <UCard v-if="groups.revoked.length" class="border border-default bg-default">
        <ul class="divide-y divide-default">
          <li v-for="row in groups.revoked" :key="row.email" class="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <p class="truncate font-semibold text-highlighted">{{ row.email }}</p>
              <p class="text-sm text-muted">Originally invited {{ dateLabel(row.invited_at) }}</p>
            </div>
            <UButton size="sm" label="Re-approve" :loading="pending === confirmationKey('approve', row.email)" @click="act('approve', row)" />
          </li>
        </ul>
      </UCard>
      <UCard v-else class="border border-default bg-default">
        <p class="text-sm text-muted">No revoked access rows.</p>
      </UCard>
    </section>
  </div>
</template>
