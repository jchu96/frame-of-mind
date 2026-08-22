import type { MediaSession } from "../../../../src/domain/studio-schemas";
import { loadContextDraft } from "./context-composer";
import { loadIntentDraft } from "./intent-composer";

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

export function recordingState(
  session: MediaSession | undefined,
): RecordingReadiness {
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
