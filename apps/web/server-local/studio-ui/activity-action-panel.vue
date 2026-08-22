<script setup lang="ts">
import {
  activityActionErrorMessage,
  ActivityActionRequestError,
  createActivityActionTransport,
} from "./activity-action-client";
import {
  derivePermittedActivityActions,
  type ActivityActionId,
  type PermittedActivityAction,
} from "./activity-actions";
import {
  reduceActivityActionPanelState,
  type ActivityActionPanelState,
} from "./activity-action-panel-state";
import type { StudioJobDetail } from "./use-job-activity";

const props = defineProps<{ detail: StudioJobDetail }>();
const emit = defineEmits<{ refresh: [] }>();
const transport = createActivityActionTransport();
const panelState = ref<ActivityActionPanelState>({});
const confirming = computed(() => panelState.value.confirming);
const pending = computed(() => panelState.value.pending);
const fieldMessage = computed(() => panelState.value.fieldMessage);
const successMessage = computed(() => panelState.value.successMessage);
const retryKey = ref<string>();
const decision = computed(() => derivePermittedActivityActions({
  job: props.detail.job,
  media: props.detail.actionSnapshot.media,
  projection: props.detail.actionSnapshot.projection,
  now: new Date().toISOString(),
}));

function requestConfirmation(action: ActivityActionId): void {
  panelState.value = reduceActivityActionPanelState(panelState.value, {
    type: "request-confirmation",
    action,
  });
}

function cancelConfirmation(): void {
  panelState.value = reduceActivityActionPanelState(panelState.value, {
    type: "dismiss-confirmation",
  });
}

function confirmationQuestion(action: PermittedActivityAction): string {
  if (action.id === "cancel") return "Cancel this analysis?";
  if (action.id === "retry") return "Start a new attempt with this recording?";
  if (action.id === "reconnect-provider") return `Open Connections for ${action.label.replace("Reconnect ", "")}?`;
  if (action.id === "reimport-results") return "Add the completed results again?";
  return "Try deleting the staged recording again?";
}

async function confirmAction(action: PermittedActivityAction): Promise<void> {
  if (pending.value) return;
  panelState.value = reduceActivityActionPanelState(panelState.value, {
    type: "start",
    action: action.id,
  });
  try {
    if (action.id === "reconnect-provider") {
      await navigateTo({
        path: "/connections",
        query: {
          provider: action.provider,
          returnTo: `/activity/${props.detail.job.id}`,
        },
      });
      return;
    }
    if (action.id === "cancel") {
      await transport.cancel(props.detail.job.id);
      panelState.value = reduceActivityActionPanelState(panelState.value, {
        type: "succeed",
        message: "Cancellation requested.",
      });
    } else if (action.id === "retry") {
      retryKey.value ??=
        `studio-retry:${props.detail.job.id}:${crypto.randomUUID()}`;
      const result = await transport.retry(
        props.detail.job.id,
        retryKey.value,
      );
      await navigateTo(`/activity/${encodeURIComponent(result.job.id)}`);
      return;
    } else if (action.id === "reimport-results") {
      await transport.reimport(props.detail.job.id);
      panelState.value = reduceActivityActionPanelState(panelState.value, {
        type: "succeed",
        message: "Completed results added to the review workspace.",
      });
    } else {
      await transport.retryCleanup(props.detail.job.input.mediaSessionId);
      panelState.value = reduceActivityActionPanelState(panelState.value, {
        type: "succeed",
        message: "Local recording cleanup completed.",
      });
    }
    emit("refresh");
  } catch (error) {
    const code = error instanceof ActivityActionRequestError
      ? error.code
      : undefined;
    panelState.value = reduceActivityActionPanelState(panelState.value, {
      type: "fail",
      message: activityActionErrorMessage(action.id, code),
    });
    if (action.id === "retry" && code === "idempotency_conflict") {
      retryKey.value = undefined;
    }
  } finally {
    if (panelState.value.pending) {
      panelState.value = reduceActivityActionPanelState(panelState.value, {
        type: "finish-navigation",
      });
    }
  }
}
</script>

<template>
  <div data-activity-action-panel="local">
    <p v-if="decision.whyNot" class="text-sm leading-6 text-muted">
      {{ decision.whyNot }}
    </p>
    <ul v-if="decision.actions.length" class="space-y-4" aria-label="Permitted job actions">
      <li v-for="action in decision.actions" :key="action.id">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <p class="max-w-xs text-sm leading-6 text-muted">
            {{ action.description }}
          </p>
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            :loading="pending === action.id"
            :disabled="Boolean(pending)"
            @click="requestConfirmation(action.id)"
          >
            {{ action.label }}
          </UButton>
        </div>
        <div
          v-if="confirming === action.id"
          class="mt-3 rounded-lg border border-default bg-elevated p-3"
          role="group"
          :aria-label="`${action.label} confirmation`"
        >
          <p class="text-sm font-semibold">{{ confirmationQuestion(action) }}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <UButton
              type="button"
              size="sm"
              :color="action.id === 'cancel' ? 'error' : 'primary'"
              :loading="pending === action.id"
              :disabled="Boolean(pending)"
              @click="confirmAction(action)"
            >
              Confirm {{ action.label }}
            </UButton>
            <UButton
              type="button"
              size="sm"
              color="neutral"
              variant="ghost"
              :disabled="Boolean(pending)"
              @click="cancelConfirmation"
            >
              Keep current state
            </UButton>
          </div>
        </div>
      </li>
    </ul>
    <p v-if="successMessage" class="mt-4 text-sm font-semibold text-success" role="status">
      {{ successMessage }}
    </p>
    <p v-if="fieldMessage" class="mt-4 text-sm font-semibold text-error" role="alert">
      {{ fieldMessage }}
    </p>
  </div>
</template>
