<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

type HostedComposerStep = "intent" | "context" | "recording" | "run";

const props = defineProps<{
  current: HostedComposerStep;
  intentReady: boolean;
  recordingReady: boolean;
}>();

const routes: Record<HostedComposerStep, string> = {
  intent: "/hosted/new/intent",
  context: "/hosted/new/context",
  recording: "/hosted/new/recording",
  run: "/hosted/new/run",
};
const order: HostedComposerStep[] = ["intent", "context", "recording", "run"];
const currentIndex = computed(() => order.indexOf(props.current));
const runReady = computed(() => props.intentReady && props.recordingReady);
const items = computed<StepperItem[]>(() => [
  {
    value: "intent",
    title: "Intent",
    description: props.intentReady ? "Chosen" : "Start here",
  },
  {
    value: "context",
    title: "Context",
    description: props.intentReady ? "Recording only" : "After intent",
    disabled: currentIndex.value < 1,
  },
  {
    value: "recording",
    title: "Recording",
    description: props.recordingReady ? "Ready" : "Add a recording",
    disabled: currentIndex.value < 2,
  },
  {
    value: "run",
    title: "Run",
    description: runReady.value ? "Ready to start" : "Add a recording first",
    disabled: !runReady.value || currentIndex.value < 3,
  },
]);

async function selectStep(value: string | number | undefined): Promise<void> {
  if (typeof value !== "string" || !order.includes(value as HostedComposerStep)) return;
  const step = value as HostedComposerStep;
  if (order.indexOf(step) > currentIndex.value) return;
  await navigateTo(routes[step]);
}
</script>

<template>
  <div aria-label="New analysis progress">
    <UStepper
      :model-value="current"
      :items="items"
      value-key="value"
      class="mb-8"
      @update:model-value="selectStep"
    />
    <p v-if="!runReady" class="-mt-5 mb-8 text-sm text-muted" role="status">
      Complete Intent and add a recording before Run.
    </p>
  </div>
</template>
