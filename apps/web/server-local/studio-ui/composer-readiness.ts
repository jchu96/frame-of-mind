import type { MediaSession } from "../../../../src/domain/studio-schemas";
import { loadContextDraft } from "./context-composer";
import { loadIntentDraft } from "./intent-composer";
import {
  loadMediaResumeReceipt,
  type MediaStagingTransport,
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

export function recordingState(
  session: MediaSession | undefined,
): RecordingReadiness {
  if (!session) return "empty";
  if (sealedStatuses.has(session.status) && session.sha256) return "sealed";
  return stagingStatuses.has(session.status) ? "staging" : "empty";
}

function intentState(storage: BrowserStorage): IntentReadiness {
  const draft = loadIntentDraft(storage).draft;
  if (!draft) return "empty";
  return "custom" in draft.recipe ? "draft" : "ready";
}

export function composerReadinessFromStorage(
  storage: BrowserStorage,
  mediaSession: MediaSession | undefined,
): ComposerReadiness {
  const intent = intentState(storage);
  const context = contextState(storage);
  const recording = recordingState(mediaSession);
  return {
    intent,
    context,
    recording,
    canRun: intent === "ready" && recording === "sealed",
  };
}

export async function refreshComposerReadiness(
  storage: BrowserStorage,
  current: ComposerReadiness,
  transport: Pick<MediaStagingTransport, "status">,
): Promise<ComposerReadiness> {
  const receipt = loadMediaResumeReceipt(storage);
  if (!receipt.mediaSessionId) {
    return composerReadinessFromStorage(storage, undefined);
  }
  try {
    const mediaSession = await transport.status(receipt.mediaSessionId);
    return composerReadinessFromStorage(storage, mediaSession);
  } catch {
    const next = composerReadinessFromStorage(storage, undefined);
    return {
      ...next,
      recording: current.recording,
      canRun: next.intent === "ready" && current.recording === "sealed",
    };
  }
}
