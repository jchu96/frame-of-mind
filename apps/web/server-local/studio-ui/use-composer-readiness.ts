import { useState } from "nuxt/app";
import { computed, onMounted } from "vue";
import type { MediaSession } from "../../../../src/domain/studio-schemas";
import {
  refreshComposerReadiness,
  recordingState,
  type ComposerReadiness,
  type ContextReadiness,
  type IntentReadiness,
} from "./composer-readiness";
import { createMediaStagingTransport } from "./media-upload";

export { composerReadinessFromStorage } from "./composer-readiness";
export type {
  ComposerReadiness,
  ContextReadiness,
  IntentReadiness,
  RecordingReadiness,
} from "./composer-readiness";

const emptyReadiness: ComposerReadiness = {
  intent: "empty",
  context: "none",
  recording: "empty",
  canRun: false,
};

export function useComposerReadiness() {
  const readiness = useState<ComposerReadiness>(
    "studio-composer-readiness",
    () => ({ ...emptyReadiness }),
  );

  function apply(next: ComposerReadiness): void {
    readiness.value = next;
  }

  async function refresh(): Promise<void> {
    if (typeof sessionStorage === "undefined") return;
    apply(
      await refreshComposerReadiness(
        sessionStorage,
        readiness.value,
        createMediaStagingTransport(),
      ),
    );
  }

  function setRecordingSession(session: MediaSession | null | undefined): void {
    const recording = recordingState(session ?? undefined);
    readiness.value = {
      ...readiness.value,
      recording,
      canRun: readiness.value.intent === "ready" && recording === "sealed",
    };
  }

  function setIntentState(intent: IntentReadiness): void {
    readiness.value = {
      ...readiness.value,
      intent,
      canRun: intent === "ready" && readiness.value.recording === "sealed",
    };
  }

  function setContextState(context: ContextReadiness): void {
    readiness.value = { ...readiness.value, context };
  }

  const primaryAction = computed(() => {
    if (readiness.value.intent !== "ready") {
      return { to: "/intent", label: "Define intent" };
    }
    if (readiness.value.recording !== "sealed") {
      return { to: "/recording", label: "Add recording" };
    }
    if (
      readiness.value.context !== "committed"
      && readiness.value.context !== "video-only"
    ) {
      return { to: "/context", label: "Choose context" };
    }
    return { to: "/run", label: "Review run receipt" };
  });

  onMounted(() => {
    void refresh();
  });

  return {
    primaryAction,
    readiness,
    refresh,
    setContextState,
    setIntentState,
    setRecordingSession,
  };
}
