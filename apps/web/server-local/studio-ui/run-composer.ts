import { z } from "zod";
import {
  composerPayloadSchema,
  idempotencyKeySchema,
  mediaRetentionRequestSchema,
  type ComposerPayload,
  type MediaRetentionRequest,
  type MediaSession,
} from "../../../../src/domain/studio-schemas";
import type { ContextDraft } from "./context-composer";
import type { IntentDraft } from "./intent-composer";

export const RUN_DRAFT_STORAGE_KEY = "frame-of-mind:studio:run-draft";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storedRunDraftSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
}).strict();

const legacyRunDraftSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  retention: mediaRetentionRequestSchema,
}).strict();

export interface RunDraft {
  idempotencyKey: string;
  retention: MediaRetentionRequest;
}
export type RunBlockerCode =
  | "intent_missing"
  | "intent_unreadable"
  | "custom_recipe"
  | "recipe_changed"
  | "recipe_unavailable"
  | "context_missing"
  | "context_uncommitted"
  | "context_unavailable"
  | "recording_missing"
  | "recording_unsealed"
  | "recording_expired"
  | "readiness_stale";

export interface RunBlocker {
  code: RunBlockerCode;
  message: string;
  link: "/intent" | "/context" | "/recording";
}

export interface RunFieldError {
  section: "intent" | "context" | "recording" | "connections" | "home";
  message: string;
  canStartFreshReceipt?: boolean;
}

export interface RunRetentionDisplay {
  mode: MediaRetentionRequest["mode"] | "unavailable";
  expiresAt?: string;
  ttlSeconds?: number;
}

export interface RunRecipeSummary {
  id: string;
  label: string;
  revision: string;
}

interface IntentLoad {
  draft?: IntentDraft;
  storageAvailable: boolean;
  invalid?: boolean;
}

export function intentReceiptStatus(
  loaded: IntentLoad,
  recipes: readonly RunRecipeSummary[] | undefined,
): { ready: boolean; label: string } {
  const result = deriveIntent(loaded, recipes);
  return result.blocker
    ? { ready: false, label: result.blocker.message }
    : { ready: true, label: "Ready" };
}

interface ContextLoad {
  draft?: ContextDraft;
  storageAvailable: boolean;
}

export interface RunReceiptState {
  canSubmit: boolean;
  blockers: RunBlocker[];
  intent: {
    label: string;
    draft?: IntentDraft;
    blocker?: RunBlocker;
  };
  context: {
    label: string;
    draft?: ContextDraft;
    blocker?: RunBlocker;
  };
  recording: {
    session?: MediaSession;
    blocker?: RunBlocker;
  };
}

export function deriveRunReceiptState(input: {
  intent: IntentLoad;
  context: ContextLoad;
  mediaSession: MediaSession | undefined;
  recipes: readonly RunRecipeSummary[] | undefined;
  readinessCanRun: boolean;
  now: string;
  contextFileAvailable?: boolean;
}): RunReceiptState {
  const intent = deriveIntent(input.intent, input.recipes);
  const context = deriveContext(
    input.context,
    input.contextFileAvailable ?? true,
  );
  const recording = deriveRecording(input.mediaSession, input.now);
  const blockers = [
    intent.blocker,
    context.blocker,
    recording.blocker,
  ].filter((value): value is RunBlocker => Boolean(value));
  if (!input.readinessCanRun && blockers.length === 0) {
    blockers.push({
      code: "readiness_stale",
      message: "Composer readiness changed. Reopen the affected section.",
      link: "/intent",
    });
  }
  return {
    canSubmit: blockers.length === 0 && input.readinessCanRun,
    blockers,
    intent,
    context,
    recording,
  };
}

function deriveIntent(
  loaded: IntentLoad,
  recipes: readonly RunRecipeSummary[] | undefined,
): RunReceiptState["intent"] {
  if (!loaded.storageAvailable || loaded.invalid) {
    return blockedIntent(
      "intent_unreadable",
      "Intent draft is unreadable. Reopen Intent and save it again.",
    );
  }
  if (!loaded.draft) {
    return blockedIntent(
      "intent_missing",
      "Intent is missing. Choose and save a built-in recipe.",
    );
  }
  if ("custom" in loaded.draft.recipe) {
    return {
      label: loaded.draft.recipe.custom.label,
      draft: loaded.draft,
      blocker: {
        code: "custom_recipe",
        message: "Custom recipes cannot run until private staging ships.",
        link: "/intent",
      },
    };
  }
  if (!recipes) {
    return {
      label: loaded.draft.recipe.id,
      draft: loaded.draft,
      blocker: {
        code: "recipe_unavailable",
        message: "Recipe catalog is unavailable. Reopen Intent after it recovers.",
        link: "/intent",
      },
    };
  }
  const recipe = recipes.find((item) => item.id === loaded.draft!.recipe.id);
  if (!recipe) {
    return {
      label: loaded.draft.recipe.id,
      draft: loaded.draft,
      blocker: {
        code: "recipe_unavailable",
        message: "Selected recipe is unavailable. Choose another Intent.",
        link: "/intent",
      },
    };
  }
  if (recipe.revision !== loaded.draft.recipe.revision) {
    return {
      label: recipe.label,
      draft: loaded.draft,
      blocker: {
        code: "recipe_changed",
        message: "Selected recipe changed. Review and save the current revision.",
        link: "/intent",
      },
    };
  }
  return { label: recipe.label, draft: loaded.draft };
}

function blockedIntent(
  code: "intent_missing" | "intent_unreadable",
  message: string,
): RunReceiptState["intent"] {
  return {
    label: "Intent blocked",
    blocker: { code, message, link: "/intent" },
  };
}

function deriveContext(
  loaded: ContextLoad,
  contextFileAvailable: boolean,
): RunReceiptState["context"] {
  if (!loaded.storageAvailable || !loaded.draft) {
    return {
      label: "Context blocked",
      blocker: {
        code: "context_missing",
        message: "Context is not committed. Choose enriched or explicit video-only.",
        link: "/context",
      },
    };
  }
  if (!loaded.draft.committed) {
    return {
      label: "Context blocked",
      draft: loaded.draft,
      blocker: {
        code: "context_uncommitted",
        message: "Context changes are not committed. Review and save Context.",
        link: "/context",
      },
    };
  }
  if (
    loaded.draft.mode === "enriched"
    && loaded.draft.context.provider === "file"
    && !contextFileAvailable
  ) {
    return {
      label: "Context blocked",
      draft: loaded.draft,
      blocker: {
        code: "context_unavailable",
        message: "Local context is missing or expired. Stage and save it again.",
        link: "/context",
      },
    };
  }
  return {
    label: loaded.draft.mode === "video-only"
      ? "Video-only"
      : contextLabel(loaded.draft),
    draft: loaded.draft,
  };
}

function contextLabel(draft: ContextDraft): string {
  if (draft.mode === "video-only") return "Video-only";
  const context = draft.context;
  if (context.provider === "file") return "Local context file";
  return `${context.provider} · ${context.transport}`;
}

function deriveRecording(
  session: MediaSession | undefined,
  now: string,
): RunReceiptState["recording"] {
  if (!session) {
    return {
      blocker: {
        code: "recording_missing",
        message: "Recording receipt is missing. Stage a recording.",
        link: "/recording",
      },
    };
  }
  if (session.status !== "sealed" || !session.sha256) {
    return {
      session,
      blocker: {
        code: "recording_unsealed",
        message: "Recording is not sealed and ready for analysis.",
        link: "/recording",
      },
    };
  }
  if (Date.parse(session.retention.expiresAt) <= Date.parse(now)) {
    return {
      session,
      blocker: {
        code: "recording_expired",
        message: "Recording staging expired. Stage the recording again.",
        link: "/recording",
      },
    };
  }
  return { session };
}

export function retentionRequestForMediaSession(
  session: MediaSession,
): MediaRetentionRequest {
  if (session.retention.mode === "ephemeral") return { mode: "ephemeral" };
  const ttlSeconds = (
    Date.parse(session.retention.expiresAt) - Date.parse(session.createdAt)
  ) / 1_000;
  return mediaRetentionRequestSchema.parse({
    mode: "retained",
    ttlSeconds,
  });
}

export function runFieldErrorForJobCode(
  code: string | undefined,
): RunFieldError {
  if (code === "idempotency_conflict") {
    return {
      section: "home",
      message: "A job already exists under this retry key. Open Home, or start a fresh receipt.",
      canStartFreshReceipt: true,
    };
  }
  if (code === "custom_recipe_staging_unavailable") {
    return { section: "intent", message: "Custom recipes cannot run yet. Choose a built-in Intent." };
  }
  if (code === "recipe_receipt_mismatch" || code === "recipe_not_found") {
    return { section: "intent", message: "The recipe changed or is unavailable. Review Intent." };
  }
  if (code === "media_retention_mismatch") {
    return {
      section: "recording",
      message: "The recording's retention changed. Reopen Run to refresh the exact receipt.",
    };
  }
  if (code?.startsWith("context_")) {
    return { section: "context", message: "Context is unavailable or changed. Review Context." };
  }
  if (
    code === "gemini_not_configured"
    || code === "granola_api_not_configured"
    || code?.endsWith("_oauth_not_configured")
  ) {
    return { section: "connections", message: "The exact analysis connection is not configured. Review Connections." };
  }
  return { section: "recording", message: "The staged recording is unavailable, changed, or expired. Review Recording." };
}

export function createOrLoadRunDraft(
  storage: BrowserStorage,
  retention: MediaRetentionRequest,
  createIdempotencyKey: () => string = () => `studio-run:${crypto.randomUUID()}`,
): RunDraft {
  const raw = storage.getItem(RUN_DRAFT_STORAGE_KEY);
  if (raw) {
    let stored: { idempotencyKey: string } | undefined;
    try {
      const value: unknown = JSON.parse(raw);
      const current = storedRunDraftSchema.safeParse(value);
      const legacy = legacyRunDraftSchema.safeParse(value);
      stored = current.success
        ? current.data
        : legacy.success
          ? { idempotencyKey: legacy.data.idempotencyKey }
          : undefined;
    } catch {
      // Replace unreadable optional browser state below.
    }
    if (stored) {
      const serialized = JSON.stringify(stored);
      if (serialized !== raw) {
        storage.setItem(RUN_DRAFT_STORAGE_KEY, serialized);
      }
      return { ...stored, retention };
    }
  }
  const stored = storedRunDraftSchema.parse({
    idempotencyKey: createIdempotencyKey(),
  });
  storage.setItem(RUN_DRAFT_STORAGE_KEY, JSON.stringify(stored));
  return { ...stored, retention };
}

export function clearRunDraft(storage: BrowserStorage): boolean {
  try {
    storage.removeItem(RUN_DRAFT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function startFreshRunReceipt(
  storage: BrowserStorage,
  retention: MediaRetentionRequest,
  createIdempotencyKey?: () => string,
): RunDraft {
  if (!clearRunDraft(storage)) {
    throw new Error("Run retry state could not be cleared.");
  }
  return createOrLoadRunDraft(storage, retention, createIdempotencyKey);
}

export function runRetentionDisplay(
  mediaSession: MediaSession | undefined,
  runDraft: RunDraft | undefined,
): RunRetentionDisplay {
  if (!runDraft) {
    return {
      mode: "unavailable",
      ...(mediaSession
        ? { expiresAt: mediaSession.retention.expiresAt }
        : {}),
    };
  }
  return {
    mode: runDraft.retention.mode,
    ...(runDraft.retention.mode === "retained"
      ? { ttlSeconds: runDraft.retention.ttlSeconds }
      : {}),
    ...(mediaSession
      ? { expiresAt: mediaSession.retention.expiresAt }
      : {}),
  };
}

export function canStartRunAnalysis(
  state: Pick<RunReceiptState, "canSubmit"> | undefined,
  runDraft: RunDraft | undefined,
): boolean {
  return Boolean(state?.canSubmit && runDraft);
}

export function buildComposerPayload(
  state: RunReceiptState,
  runDraft: RunDraft,
): ComposerPayload {
  if (
    !state.canSubmit
    || !state.intent.draft
    || !state.context.draft
    || !state.recording.session
  ) {
    throw new Error("Run receipt is blocked.");
  }
  const contextDraft = state.context.draft;
  return composerPayloadSchema.parse({
    idempotencyKey: runDraft.idempotencyKey,
    mediaSessionId: state.recording.session.id,
    context: contextDraft.mode === "video-only"
      ? { mode: "none" }
      : contextDraft.context,
    recipe: state.intent.draft.recipe,
    model: state.intent.draft.model,
    ...(state.intent.draft.focus
      ? { focus: state.intent.draft.focus }
      : {}),
    ...(contextDraft.mode === "enriched"
        && contextDraft.transcriptOffsetSeconds !== undefined
      ? { transcriptOffsetSeconds: contextDraft.transcriptOffsetSeconds }
      : {}),
    retention: runDraft.retention,
  });
}
