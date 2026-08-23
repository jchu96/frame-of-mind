<script setup lang="ts">
import { z } from "zod";
import type { FormSubmitEvent } from "@nuxt/ui";
import type { SessionInfo } from "../../shared/types";

definePageMeta({ layout: false });
useHead({ title: "Sign in · Frame of Mind" });

const route = useRoute();
const next = computed(() => safeHostedNext(route.query.next));
const { data: session } = await useFetch<SessionInfo>("/api/session", {
  headers: useRequestHeaders(["cookie"]),
});
if (session.value?.principal) await navigateTo(next.value);

const schema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
});
type SignInForm = z.output<typeof schema>;

const state = reactive<SignInForm>({ email: "" });
const githubPending = ref(false);
const emailPending = ref(false);
const feedback = ref("");
const toast = useToast();
const authClient = useHostedAuth();

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const payload = (error as { data?: unknown }).data;
  if (payload && typeof payload === "object") {
    const direct = (payload as { code?: unknown }).code;
    if (typeof direct === "string") return direct;
    const nested = (payload as { data?: unknown }).data;
    if (nested && typeof nested === "object") {
      const code = (nested as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  const direct = (error as { code?: unknown }).code;
  return typeof direct === "string" ? direct : undefined;
}

function friendlyAuthMessage(code: string | undefined): string {
  if (code === "MAILER_UNAVAILABLE") {
    return "Email sign-in is not enabled on this deployment.";
  }
  if (code === "EMAIL_NOT_INVITED") {
    return "This email has not been invited to Frame of Mind.";
  }
  return "Sign-in could not be started. Please try again.";
}

const callbackError = [
  route.query.error,
  route.query.error_code,
  route.query.error_description,
].flat().find((value) => typeof value === "string") as string | undefined;
if (callbackError) {
  feedback.value = friendlyAuthMessage(
    callbackError.toUpperCase().includes("EMAIL_NOT_INVITED")
      ? "EMAIL_NOT_INVITED"
      : callbackError,
  );
}

async function signInWithGithub() {
  githubPending.value = true;
  feedback.value = "";
  try {
    const result = await authClient.signIn.social({
      provider: "github",
      callbackURL: next.value,
      errorCallbackURL: `/sign-in?next=${encodeURIComponent(next.value)}`,
    });
    if (result.error) feedback.value = friendlyAuthMessage(result.error.code);
  } catch (error) {
    feedback.value = friendlyAuthMessage(extractErrorCode(error));
  } finally {
    githubPending.value = false;
  }
}

async function sendMagicLink(event: FormSubmitEvent<SignInForm>) {
  emailPending.value = true;
  feedback.value = "";
  try {
    await $fetch("/api/auth/sign-in/magic-link", {
      method: "POST",
      body: {
        email: event.data.email,
        name: event.data.email,
        callbackURL: next.value,
      },
    });
    toast.add({
      title: "Check your email",
      description: "Use the sign-in link within five minutes.",
      color: "success",
      icon: "i-lucide-mail-check",
    });
  } catch (error) {
    feedback.value = friendlyAuthMessage(extractErrorCode(error));
  } finally {
    emailPending.value = false;
  }
}
</script>

<template>
  <main class="grid min-h-screen place-items-center bg-default px-4 py-12 text-highlighted">
    <UCard class="w-full max-w-md border border-default bg-default">
      <template #header>
        <div class="space-y-2">
          <p class="text-sm font-semibold text-muted">Frame of Mind</p>
          <h1 class="text-3xl font-black tracking-tight text-highlighted">Sign in</h1>
          <p class="text-sm leading-6 text-muted">
            Use an invited GitHub account or request a one-time email link.
          </p>
        </div>
      </template>

      <div class="space-y-6">
        <UButton
          block
          color="neutral"
          variant="outline"
          icon="i-simple-icons-github"
          label="Continue with GitHub"
          :loading="githubPending"
          @click="signInWithGithub"
        />

        <USeparator label="or" />

        <UForm :schema="schema" :state="state" class="space-y-4" @submit="sendMagicLink">
          <UFormField
            name="email"
            label="Email address"
            description="We will send a one-time sign-in link if email sign-in is enabled."
          >
            <UInput
              v-model="state.email"
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              class="w-full"
            />
          </UFormField>
          <UButton
            block
            type="submit"
            label="Email me a sign-in link"
            :loading="emailPending"
          />
        </UForm>

        <UAlert
          v-if="feedback"
          color="warning"
          variant="soft"
          title="Sign-in unavailable"
          :description="feedback"
        />
      </div>
    </UCard>
  </main>
</template>
