import { computed, onMounted } from "vue";
import type { MediaSession } from "../../../../src/domain/studio-schemas";
import { loadContextDraft } from "./context-composer";
import { loadIntentDraft } from "./intent-composer";
import {
  createMediaStagingTransport,
  loadMediaResumeReceipt,
} from "./media-upload";

export type IntentReadiness = "empty" | "draft" | "ready";
export type ContextReadiness =
  | "none"
  | "draft"
  | "committed"
  | "video-only";
export type RecordingReadiness = "empty" | "staging" | "sealed";

export interface ComposerReadiness {
  intent: IntentReadiness;
  context: ContextReadiness;
  recording: RecordingReadiness;
  canRun: boolean;
}

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const sealedStatuses = new Set<MediaSession["status"]>([
  "sealed",
  "retained",
  "in_use",
]);
const stagingStatuses = new Set<MediaSession["status"]>([
  "created",
  "uploading",
]);

function contextState(storage: BrowserStorage): ContextReadiness {
  const draft = loadContextDraft(storage).draft;
  if (!draft) return "none";
  if (!draft.committed) return "draft";
  return draft.mode === "video-only" ? "video-only" : "committed";
}

function recordingState(session: MediaSession | undefined): RecordingReadiness {
  if (!session) return "empty";
  if (sealedStatuses.has(session.status) && session.sha256) return "sealed";
  return stagingStatuses.has(session.status) ? "staging" : "empty";
}

export function composerReadinessFromStorage(
  storage: BrowserStorage,
  mediaSession: MediaSession | undefined,
): ComposerReadiness {
  const intent: IntentReadiness = loadIntentDraft(storage).draft
    ? "ready"
    : "empty";
  const context = contextState(storage);
  const recording = recordingState(mediaSession);
  return {
    intent,
    context,
    recording,
    canRun: intent === "ready" && recording === "sealed",
  };
}

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
    const receipt = loadMediaResumeReceipt(sessionStorage);
    let mediaSession: MediaSession | undefined;
    if (receipt.mediaSessionId) {
      try {
        mediaSession = await createMediaStagingTransport().status(
          receipt.mediaSessionId,
        );
      } catch {
        mediaSession = undefined;
      }
    }
    apply(composerReadinessFromStorage(sessionStorage, mediaSession));
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
    return { to: "/intent", label: "Review intent" };
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
