import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from "vue";
import {
  clearMediaResumeReceipt,
  loadMediaResumeReceipt,
  persistMediaResumeReceipt,
} from "../../app/studio/media-upload.js";
import type { HostedMediaView } from "../../../workflows/src/contracts.js";
import type { HostedMediaOpenSession } from "../../../workflows/src/media.js";
import { hostedStorage } from "./hosted-adapter.js";
import {
  HostedMediaClientError,
  abandonHostedMediaOnExit,
  cancelHostedMedia,
  clearHostedMediaDraft,
  createHostedMedia,
  hashHostedRecording,
  listOpenHostedMedia,
  loadHostedMediaDraft,
  mediaDurationSeconds,
  persistHostedMediaDraft,
  queryHostedUploadOffset,
  resumeHostedMedia,
  sealHostedMedia,
  uploadHostedRecording,
  validateHostedRecording,
  withHostedUploadLock,
  type HostedMediaDraft,
} from "./hosted-media-upload.js";
import { formatRecordingBytes } from "../../app/studio/recording-display.js";

export type HostedMediaPhase =
  | "idle"
  | "restoring"
  | "selected"
  | "hashing"
  | "creating"
  | "open-session-choice"
  | "reselect-required"
  | "ready-to-resume"
  | "uploading"
  | "paused"
  | "sealing"
  | "sealed"
  | "canceling"
  | "abandoned"
  | "failed";

export function useHostedMediaUpload(options: { maxBytes?: number } = {}) {
  const browser = globalThis as unknown as {
    addEventListener(type: "pagehide", listener: () => void): void;
    removeEventListener(type: "pagehide", listener: () => void): void;
    document: {
      visibilityState: string;
      addEventListener(type: "visibilitychange", listener: () => void): void;
      removeEventListener(type: "visibilitychange", listener: () => void): void;
    };
  };
  const storage = typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  const file = shallowRef<File | null>(null);
  const draft = shallowRef<HostedMediaDraft>();
  const media = shallowRef<HostedMediaView>();
  const openSessions = shallowRef<HostedMediaOpenSession[]>([]);
  const phase = ref<HostedMediaPhase>("idle");
  const retention = ref<"ephemeral" | "retained">("ephemeral");
  const fieldError = ref<string>();
  const operationError = ref<string>();
  const progressBytes = ref(0);
  const hashBytes = ref(0);
  let controller: AbortController | undefined;
  let active: Promise<void> | undefined;
  const exitAbandons = new Set<string>();

  const busy = computed(() => [
    "restoring", "hashing", "creating", "uploading", "sealing", "canceling",
  ].includes(phase.value));
  const totalBytes = computed(() => draft.value?.declaredSizeBytes ?? file.value?.size ?? 0);
  const statusMessage = computed(() => {
    return hostedMediaStatusMessage(phase.value, {
      hashBytes: hashBytes.value,
      progressBytes: progressBytes.value,
      totalBytes: totalBytes.value,
    });
  });

  const fileModel = computed<File | null>({
    get: () => file.value,
    set: (selected) => {
      if (busy.value) return;
      file.value = selected;
      fieldError.value = undefined;
      operationError.value = undefined;
      if (!selected) {
        phase.value = draft.value ? "reselect-required" : "idle";
        return;
      }
      const validation = validateHostedRecording(selected);
      if (!validation.ok) {
        fieldError.value = validation.message;
        phase.value = draft.value ? "reselect-required" : "idle";
        return;
      }
      if (draft.value) {
        if (selected.size !== draft.value.declaredSizeBytes || validation.mimeType !== draft.value.mimeType) {
          fieldError.value = "Choose the same recording used to open this upload.";
          phase.value = "reselect-required";
        } else {
          phase.value = "ready-to-resume";
        }
      } else {
        phase.value = "selected";
      }
    },
  });

  async function restore(): Promise<void> {
    if (!storage) return;
    phase.value = "restoring";
    const storedDraft = loadHostedMediaDraft(storage);
    if (!storedDraft) {
      const sealed = loadMediaResumeReceipt(hostedStorage(storage)).mediaSessionId;
      if (sealed) {
        try {
          const response = await fetch(
            `/api/hosted/media/${encodeURIComponent(sealed)}`,
            { credentials: "same-origin" },
          );
          if (!response.ok) throw new Error("unavailable");
          const value = await response.json() as { media?: HostedMediaView };
          if (!value.media) throw new Error("invalid");
          media.value = value.media;
          phase.value = "sealed";
          return;
        } catch {
          clearMediaResumeReceipt(hostedStorage(storage));
        }
      }
    }
    try {
      openSessions.value = await listOpenHostedMedia();
    } catch (error) {
      operationError.value = error instanceof HostedMediaClientError
        ? hostedMediaErrorMessage(error, options.maxBytes)
        : "Hosted Studio could not recover unfinished uploads.";
      phase.value = "failed";
      return;
    }
    const serverDraft = storedDraft
      ? openSessions.value.find((session) => session.mediaId === storedDraft.mediaId)
      : undefined;
    if (storedDraft && !serverDraft) clearHostedMediaDraft(storage);
    draft.value = storedDraft && serverDraft
      ? { schemaVersion: 1, ...serverDraft, offset: storedDraft.offset }
      : undefined;
    if (draft.value) {
      persistHostedMediaDraft(storage, draft.value);
      progressBytes.value = draft.value.offset;
      retention.value = draft.value.retention;
      phase.value = "reselect-required";
      return;
    }
    if (openSessions.value.length > 0) {
      phase.value = "open-session-choice";
      return;
    }
    phase.value = "idle";
  }

  async function resumeOpenSession(session: HostedMediaOpenSession): Promise<void> {
    if (!storage || active) return;
    return await runExclusive(async () => {
      controller = new AbortController();
      operationError.value = undefined;
      try {
        draft.value = await resumeHostedMedia(session, controller.signal);
        persistHostedMediaDraft(storage, draft.value);
        progressBytes.value = draft.value.offset;
        retention.value = draft.value.retention;
        openSessions.value = openSessions.value.filter(
          (candidate) => candidate.mediaId !== session.mediaId,
        );
        phase.value = "reselect-required";
      } catch (error) {
        operationError.value = error instanceof HostedMediaClientError
          ? hostedMediaErrorMessage(error, options.maxBytes)
          : "Could not resume this upload.";
        phase.value = "failed";
      } finally {
        controller = undefined;
      }
    });
  }

  async function discardOpenSession(session: HostedMediaOpenSession): Promise<void> {
    if (active) return;
    return await runExclusive(async () => {
      phase.value = "canceling";
      operationError.value = undefined;
      try {
        await cancelHostedMedia(session.mediaId);
        openSessions.value = openSessions.value.filter(
          (candidate) => candidate.mediaId !== session.mediaId,
        );
        phase.value = openSessions.value.length > 0
          ? "open-session-choice"
          : "abandoned";
      } catch (error) {
        operationError.value = error instanceof HostedMediaClientError
          ? hostedMediaErrorMessage(error, options.maxBytes)
          : "Could not discard this upload.";
        phase.value = "failed";
      }
    });
  }

  function runExclusive(work: () => Promise<void>): Promise<void> {
    if (active) return active;
    active = work().finally(() => { active = undefined; });
    return active;
  }

  function start(): Promise<void> {
    return runExclusive(async () => {
      const selected = file.value;
      if (!selected || !storage) {
        fieldError.value = "Choose a recording before starting the upload.";
        return;
      }
      const validation = validateHostedRecording(selected);
      if (!validation.ok) {
        fieldError.value = validation.message;
        return;
      }
      controller = new AbortController();
      operationError.value = undefined;
      try {
        phase.value = "hashing";
        hashBytes.value = 0;
        const sha256 = await hashHostedRecording(selected, {
          signal: controller.signal,
          onProgress: (bytes) => { hashBytes.value = bytes; },
        });
        if (draft.value) {
          if (sha256 !== draft.value.declaredSha256) {
            fieldError.value = "This recording does not match the unfinished upload.";
            phase.value = "reselect-required";
            return;
          }
        } else {
          phase.value = "creating";
          const durationSeconds = await mediaDurationSeconds(selected);
          draft.value = await createHostedMedia({
            declaredSizeBytes: selected.size,
            declaredSha256: sha256,
            mimeType: validation.mimeType,
            durationSeconds,
            retention: retention.value,
          }, controller.signal);
          persistHostedMediaDraft(storage, draft.value);
        }
        const activeDraft = draft.value;
        await withHostedUploadLock(activeDraft.mediaId, async () => {
          phase.value = "uploading";
          await uploadHostedRecording({
            file: selected,
            draft: activeDraft,
            signal: controller?.signal,
            onProgress: (bytes) => { progressBytes.value = bytes; },
            onConfirmed: (offset) => {
              if (!draft.value) return;
              draft.value = { ...draft.value, offset };
              progressBytes.value = offset;
              persistHostedMediaDraft(storage, draft.value);
            },
          });
          phase.value = "sealing";
          media.value = await sealHostedMedia(activeDraft.mediaId, controller?.signal);
        });
        const sealedMedia = media.value;
        if (!sealedMedia) throw new HostedMediaClientError("hosted_media_seal_invalid");
        clearHostedMediaDraft(storage);
        persistMediaResumeReceipt(hostedStorage(storage), sealedMedia.id);
        draft.value = undefined;
        progressBytes.value = selected.size;
        phase.value = "sealed";
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          if (phase.value === "abandoned") {
            phase.value = "abandoned";
          } else {
            await reconcileOffset();
            phase.value = "paused";
          }
        } else {
          operationError.value = error instanceof HostedMediaClientError
            ? hostedMediaErrorMessage(error, options.maxBytes)
            : "Could not upload this recording.";
          phase.value = "failed";
        }
      } finally {
        controller = undefined;
      }
    });
  }

  function pause(): void { controller?.abort(); }

  async function reconcileOffset(): Promise<void> {
    if (!draft.value || !storage) return;
    try {
      const offset = await queryHostedUploadOffset(draft.value);
      draft.value = { ...draft.value, offset };
      progressBytes.value = offset;
      persistHostedMediaDraft(storage, draft.value);
    } catch {
      // The persisted confirmed offset remains an honest lower bound.
    }
  }

  async function cancel(): Promise<void> {
    controller?.abort();
    const running = active;
    if (running) await running;
    return await runExclusive(async () => {
      if (!draft.value || !storage) return;
      phase.value = "canceling";
      try {
        await cancelHostedMedia(draft.value.mediaId);
        clearHostedMediaDraft(storage);
        draft.value = undefined;
        file.value = null;
        progressBytes.value = 0;
        phase.value = "abandoned";
      } catch (error) {
        operationError.value = error instanceof HostedMediaClientError
          ? hostedMediaErrorMessage(error, options.maxBytes)
          : "Could not cancel this upload.";
        phase.value = "failed";
      }
    });
  }

  function abandonForPageExit(): void {
    const current = draft.value;
    if (
      !current
      || ["sealed", "canceling", "abandoned"].includes(phase.value)
      || exitAbandons.has(current.mediaId)
    ) return;
    exitAbandons.add(current.mediaId);
    controller?.abort();
    if (storage) clearHostedMediaDraft(storage);
    abandonHostedMediaOnExit(current.mediaId);
    draft.value = undefined;
    file.value = null;
    phase.value = "abandoned";
  }

  function onVisibilityChange(): void {
    if (browser.document.visibilityState === "hidden") abandonForPageExit();
  }

  function replace(): void {
    if (!storage || busy.value) return;
    clearMediaResumeReceipt(hostedStorage(storage));
    media.value = undefined;
    file.value = null;
    progressBytes.value = 0;
    hashBytes.value = 0;
    fieldError.value = undefined;
    operationError.value = undefined;
    phase.value = "idle";
  }

  onMounted(() => {
    browser.addEventListener("pagehide", abandonForPageExit);
    browser.document.addEventListener("visibilitychange", onVisibilityChange);
    void restore();
  });
  onBeforeUnmount(() => {
    browser.removeEventListener("pagehide", abandonForPageExit);
    browser.document.removeEventListener("visibilitychange", onVisibilityChange);
    abandonForPageExit();
  });

  return {
    busy, cancel, discardOpenSession, draft, fieldError, fileModel, media,
    openSessions, operationError, pause, phase, progressBytes, resumeOpenSession,
    replace, retention, start, statusMessage, totalBytes,
  };
}

export function hostedMediaStatusMessage(
  phase: HostedMediaPhase,
  progress: { hashBytes: number; progressBytes: number; totalBytes: number },
): string {
  if (phase === "restoring") return "Checking your last upload…";
  if (phase === "selected") return "Recording selected";
  if (phase === "hashing") return "Checking the file…";
  if (phase === "creating") return "Preparing upload…";
  if (phase === "open-session-choice") return "Choose an unfinished upload to continue or discard.";
  if (phase === "reselect-required") return "Choose the same recording to continue this upload.";
  if (phase === "ready-to-resume") return "Recording matched. Continue the upload.";
  if (phase === "uploading") {
    return `Uploading — ${formatRecordingBytes(progress.progressBytes)} of ${formatRecordingBytes(progress.totalBytes)}`;
  }
  if (phase === "paused") return "Upload paused";
  if (phase === "sealing") return "Verifying the upload…";
  if (phase === "sealed") return "Recording ready";
  if (phase === "canceling") return "Cancelling upload…";
  if (phase === "abandoned") return "Upload cancelled";
  if (phase === "failed") return "Upload needs attention";
  return "Choose a recording.";
}

export function hostedMediaStatusLabel(phase: HostedMediaPhase): string {
  if (["hashing", "creating", "uploading", "sealing", "canceling"].includes(phase)) return "In progress";
  if (phase === "restoring") return "Checking";
  if (phase === "selected") return "Selected";
  if (phase === "open-session-choice") return "Action needed";
  if (phase === "reselect-required") return "Choose file";
  if (phase === "ready-to-resume") return "Ready to continue";
  if (phase === "paused") return "Paused";
  if (phase === "sealed") return "Ready";
  if (phase === "abandoned") return "Cancelled";
  if (phase === "failed") return "Needs attention";
  return "Ready";
}

export function hostedMediaStatusColor(
  phase: HostedMediaPhase,
): "info" | "success" | "error" | "warning" | "neutral" {
  if (phase === "sealed") return "success";
  if (phase === "failed") return "error";
  if (["paused", "reselect-required", "open-session-choice"].includes(phase)) return "warning";
  if (["abandoned", "idle"].includes(phase)) return "neutral";
  return "info";
}

function hostedMediaErrorMessage(
  error: HostedMediaClientError,
  maxBytes?: number,
): string {
  if (error.code === "hosted_media_size_exceeded" && maxBytes) {
    return `This recording is larger than ${formatRecordingBytes(maxBytes)}.`;
  }
  return error.message;
}
