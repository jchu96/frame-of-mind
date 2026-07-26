<script setup lang="ts">
import type { ConfigurationStatus } from "../../../../src/domain/studio-schemas";

useSeoMeta({
  title: "Connections · Frame of Mind",
  description: "Configure local Frame of Mind Studio provider connections.",
});

type ProviderName = "gemini" | "bluedot" | "granola";
type SecretProviderName = "gemini" | "granola";

const { data: configuration, error, refresh, status } =
  await useFetch<ConfigurationStatus>("/api/studio/configuration", {
    server: false,
  });
const toast = useToast();
const secretInput = reactive<Record<SecretProviderName, string>>({
  gemini: "",
  granola: "",
});
const busy = reactive<Record<ProviderName, boolean>>({
  gemini: false,
  bluedot: false,
  granola: false,
});

function provider(name: ProviderName) {
  return configuration.value?.providers.find(
    (candidate) => candidate.provider === name,
  );
}

function sourceLabel(name: ProviderName): string {
  const source = provider(name)?.source;
  if (source === "environment") return ".env / environment";
  if (source === "session") return "This Bun process";
  if (source === "oauth") return "Private OAuth file";
  return "Not configured";
}

function lifetimeLabel(name: ProviderName): string {
  const lifetime = provider(name)?.lifetime;
  if (lifetime === "persistent-oauth") return "Persists until disconnected";
  if (lifetime === "process") {
    return provider(name)?.source === "environment"
      ? "Reloaded from your environment at launch"
      : "Cleared when Bun stops";
  }
  return "No credential";
}

async function saveSecret(name: SecretProviderName) {
  const value = secretInput[name];
  if (!value) return;
  busy[name] = true;
  try {
    configuration.value = await $fetch<ConfigurationStatus>(
      `/api/studio/configuration/secrets/${name}-api-key`,
      {
        method: "PUT",
        body: { value },
      },
    );
    secretInput[name] = "";
    toast.add({
      title: `${name === "gemini" ? "Gemini" : "Granola"} available for this launch`,
      description: "The value was not written to SQLite or a new settings file.",
      color: "success",
      icon: "i-lucide-check",
    });
  } catch {
    toast.add({
      title: "Could not save the temporary key",
      description: "Check the value and try again.",
      color: "error",
      icon: "i-lucide-triangle-alert",
    });
  } finally {
    busy[name] = false;
  }
}

async function clearSecret(name: SecretProviderName) {
  busy[name] = true;
  try {
    configuration.value = await $fetch<ConfigurationStatus>(
      `/api/studio/configuration/secrets/${name}-api-key`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: {},
      },
    );
    secretInput[name] = "";
    toast.add({
      title: "Temporary key cleared",
      description: "Environment values, if present, were not changed.",
      color: "neutral",
    });
  } catch {
    toast.add({
      title: "Could not clear the temporary key",
      color: "error",
    });
  } finally {
    busy[name] = false;
  }
}

async function connectOAuth(name: "bluedot" | "granola") {
  busy[name] = true;
  try {
    const result = await $fetch<{ accepted: boolean }>(
      `/api/studio/connections/${name}/oauth`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {},
      },
    );
    toast.add({
      title: result.accepted
        ? "Authorization started"
        : "Authorization already in progress",
      description: "Complete the provider prompt, then refresh connection status.",
      color: "primary",
      icon: "i-lucide-external-link",
    });
  } catch {
    toast.add({
      title: "Could not start provider authorization",
      description: "Check the local server output and provider endpoint.",
      color: "error",
    });
  } finally {
    busy[name] = false;
  }
}
</script>

<template>
  <div>
    <AppHeader />
    <main class="fom-shell py-10 sm:py-14">
      <section class="grid gap-8 lg:grid-cols-[1fr_0.55fr] lg:items-end">
        <div>
          <p class="fom-kicker text-emerald-700">Local Studio</p>
          <h1 class="mt-4 text-4xl font-black tracking-[-0.045em] sm:text-6xl">
            Connections, without a credential vault.
          </h1>
          <p class="mt-5 max-w-3xl text-base leading-7 text-zinc-600 sm:text-lg">
            Reusable API keys stay in your ignored <code>.env</code>. Keys
            entered here live only in this Bun process. OAuth remains in the
            provider-specific private files already used by the CLI.
          </p>
        </div>
        <UAlert
          color="neutral"
          variant="soft"
          icon="i-lucide-shield-check"
          title="Per-launch local session"
          description="This page requires the one-time launch link. Restarting Bun creates a new browser session."
        />
      </section>

      <UAlert
        v-if="status === 'idle' || status === 'pending'"
        class="mt-8"
        color="neutral"
        variant="soft"
        icon="i-lucide-loader-circle"
        title="Reading local connection status"
        description="Credential values are never returned to this page."
      />

      <UAlert
        v-else-if="error"
        class="mt-8"
        color="error"
        variant="soft"
        title="Connection status is unavailable"
        description="Restart with bun run studio and open its new one-time URL."
      />

      <section v-else class="mt-10 grid gap-5 lg:grid-cols-3" aria-label="Provider connections">
        <UCard v-for="name in (['gemini', 'bluedot', 'granola'] as ProviderName[])" :key="name">
          <template #header>
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
                  {{ name === 'gemini' ? 'Analysis' : 'Meeting context' }}
                </p>
                <h2 class="mt-1 text-xl font-black capitalize">{{ name }}</h2>
              </div>
              <UBadge
                :color="provider(name)?.connected ? 'success' : 'neutral'"
                :variant="provider(name)?.connected ? 'soft' : 'outline'"
              >
                {{ provider(name)?.connected ? 'Configured' : 'Not configured' }}
              </UBadge>
            </div>
          </template>

          <dl class="grid gap-4 text-sm">
            <div>
              <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">Source</dt>
              <dd class="mt-1 font-semibold">{{ sourceLabel(name) }}</dd>
            </div>
            <div>
              <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">Lifetime</dt>
              <dd class="mt-1 text-zinc-600">{{ lifetimeLabel(name) }}</dd>
            </div>
            <div v-if="provider(name)?.lastVerifiedAt">
              <dt class="text-xs font-bold uppercase tracking-wider text-zinc-500">Last verified</dt>
              <dd class="mt-1 text-zinc-600">{{ provider(name)?.lastVerifiedAt }}</dd>
            </div>
          </dl>

          <UAlert
            v-if="provider(name)?.failureCode"
            class="mt-5"
            color="warning"
            variant="soft"
            icon="i-lucide-triangle-alert"
            title="Provider status needs attention"
            description="Verify the configured endpoint and reconnect. Secret details are not shown."
          />

          <form
            v-if="name === 'gemini' || name === 'granola'"
            class="mt-6 space-y-3"
            @submit.prevent="saveSecret(name)"
          >
            <UFormField
              :label="`${name === 'gemini' ? 'Gemini' : 'Granola'} API key`"
              :description="provider(name)?.source === 'environment'
                ? 'Environment input has precedence. Edit .env and restart to replace it.'
                : 'Stored in process memory only; the server never returns it.'"
            >
              <UInput
                v-model="secretInput[name]"
                class="w-full"
                type="password"
                autocomplete="off"
                placeholder="Paste a temporary key"
                :disabled="provider(name)?.source === 'environment'"
              />
            </UFormField>
            <div class="flex flex-wrap gap-2">
              <UButton
                type="submit"
                size="sm"
                :loading="busy[name]"
                :disabled="!secretInput[name] || provider(name)?.source === 'environment'"
              >
                Use for this launch
              </UButton>
              <UButton
                v-if="provider(name)?.source === 'session'"
                type="button"
                size="sm"
                color="neutral"
                variant="outline"
                :loading="busy[name]"
                @click="clearSecret(name)"
              >
                Clear temporary key
              </UButton>
            </div>
          </form>

          <div v-if="name === 'bluedot' || name === 'granola'" class="mt-4">
            <UButton
              size="sm"
              color="neutral"
              variant="soft"
              icon="i-lucide-key-round"
              :loading="busy[name]"
              @click="connectOAuth(name)"
            >
              {{ provider(name)?.source === 'oauth' ? 'Verify OAuth' : 'Connect with OAuth' }}
            </UButton>
            <p
              v-if="provider(name)?.source === 'oauth'"
              class="mt-2 text-xs leading-5 text-zinc-500"
            >
              To switch accounts, remove only this provider's token file using
              the credentials runbook, then connect again.
            </p>
          </div>
        </UCard>
      </section>

      <section class="fom-panel mt-8 p-6 sm:p-8" aria-labelledby="persistent-setup">
        <div class="flex flex-col justify-between gap-6 lg:flex-row lg:items-start">
          <div class="max-w-2xl">
            <p class="fom-kicker text-zinc-500">Recommended persistence</p>
            <h2 id="persistent-setup" class="mt-2 text-2xl font-black">Keep keys in your ignored .env</h2>
            <p class="mt-3 leading-7 text-zinc-600">
              This is the easiest repeatable setup for a private local clone.
              Frame of Mind loads it when you launch Studio; the web UI does
              not write or edit the file.
            </p>
          </div>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            :loading="status === 'pending'"
            @click="refresh()"
          >
            Refresh status
          </UButton>
        </div>
        <pre class="mt-5 overflow-x-auto border border-zinc-800 bg-zinc-950 p-4 text-sm text-emerald-200"><code>cp .env.example .env
# edit locally:
GEMINI_API_KEY=...
GRANOLA_API_KEY=...

bun run studio</code></pre>
        <p class="mt-3 text-sm text-zinc-500">
          <code>.env</code> is Git-ignored. Never commit, paste, or share it.
        </p>
      </section>
    </main>
  </div>
</template>
