<script setup lang="ts">
type HostedComposerStep = "intent" | "context" | "recording" | "run";
type VisibleComposerStep = Exclude<HostedComposerStep, "context">;

const props = defineProps<{
  current: HostedComposerStep;
  intentReady: boolean;
  recordingReady: boolean;
}>();

const routes: Record<VisibleComposerStep, string> = {
  intent: "/hosted/new/intent",
  recording: "/hosted/new/recording",
  run: "/hosted/new/run",
};
const order: VisibleComposerStep[] = ["intent", "recording", "run"];
const visibleCurrent = computed<VisibleComposerStep>(() =>
  props.current === "context" ? "recording" : props.current
);
const currentIndex = computed(() => order.indexOf(visibleCurrent.value));
const runReady = computed(() => props.intentReady && props.recordingReady);
const items = computed<Array<{
  value: VisibleComposerStep;
  title: string;
  description: string;
}>>(() => [
  {
    value: "intent",
    title: "What to find",
    description: props.intentReady ? "Chosen" : "Start here",
  },
  {
    value: "recording",
    title: "Recording",
    description: props.recordingReady ? "Ready" : "Add a recording",
  },
  {
    value: "run",
    title: "Review & start",
    description: runReady.value ? "Ready to start" : "Add a recording first",
  },
]);

function disabled(step: VisibleComposerStep): boolean {
  return order.indexOf(step) > currentIndex.value;
}

async function selectStep(step: VisibleComposerStep): Promise<void> {
  if (disabled(step)) return;
  await navigateTo(routes[step]);
}
</script>

<template>
  <div role="group" aria-label="New analysis progress">
    <ol class="mb-8 grid grid-cols-3 gap-2">
      <li v-for="(item, index) in items" :key="item.value" class="min-w-0">
        <button
          type="button"
          class="flex w-full items-start gap-3 rounded-md p-2 text-left transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-55"
          :class="visibleCurrent === item.value ? 'bg-elevated' : ''"
          :disabled="disabled(item.value)"
          :aria-current="visibleCurrent === item.value ? 'step' : undefined"
          :data-composer-step="item.value"
          @click="selectStep(item.value)"
        >
          <span aria-hidden="true" class="grid size-7 shrink-0 place-items-center rounded-full border border-default text-sm font-black">{{ index + 1 }}</span>
          <span class="min-w-0">
            <span class="sr-only">Step {{ index + 1 }} of {{ items.length }}: </span>
            <span class="block font-bold text-highlighted">{{ item.title }}</span>
            <span class="mt-0.5 block text-xs text-muted">{{ item.description }}</span>
          </span>
        </button>
      </li>
    </ol>
  </div>
</template>
