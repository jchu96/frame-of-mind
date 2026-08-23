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
import { hostedStorage } from "./hosted-adapter.js";
import {
  HostedMediaClientError,
  cancelHostedMedia,
  clearHostedMediaDraft,
  createHostedMedia,
  hashHostedRecording,
  loadHostedMediaDraft,
  mediaDurationSeconds,
  persistHostedMediaDraft,
  queryHostedUploadOffset,
  sealHostedMedia,
  uploadHostedRecording,
  validateHostedRecording,
  withHostedUploadLock,
  type HostedMediaDraft,
} from "./hosted-media-upload.js";

export type HostedMediaPhase =
  | "idle"
  | "restoring"
  | "selected"
  | "hashing"
  | "creating"
  | "reselect-required"
  | "ready-to-resume"
  | "uploading"
  | "paused"
  | "sealing"
  | "sealed"
  | "canceling"
  | "abandoned"
  | "failed";

export function useHostedMediaUpload() {
  const storage = typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  const file = shallowRef<File | null>(null);
  const draft = shallowRef<HostedMediaDraft>();
  const media = shallowRef<HostedMediaView>();
  const phase = ref<HostedMediaPhase>("idle");
  const retention = ref<"ephemeral" | "retained">("ephemeral");
  const fieldError = ref<string>();
  const operationError = ref<string>();
  const progressBytes = ref(0);
  const hashBytes = ref(0);
  let controller: AbortController | undefined;
  let active: Promise<void> | undefined;

  const busy = computed(() => [
    "restoring", "hashing", "creating", "uploading", "sealing", "canceling",
  ].includes(phase.value));
  const totalBytes = computed(() => draft.value?.declaredSizeBytes ?? file.value?.size ?? 0);
  const statusMessage = computed(() => {
    if (phase.value === "restoring") return "Checking the principal-bound recording receipt.";
    if (phase.value === "selected") return "Recording selected. Start when the retention choice is correct.";
    if (phase.value === "hashing") return `Hashing ${hashBytes.value.toLocaleString()} of ${totalBytes.value.toLocaleString()} bytes in the browser.`;
    if (phase.value === "creating") return "Opening one short-lived Gemini upload session.";
    if (phase.value === "reselect-required") return "An unfinished upload was found. Reselect the same recording to resume.";
    if (phase.value === "ready-to-resume") return "Recording metadata matches. Resume to verify its digest and provider offset.";
    if (phase.value === "uploading") return `${progressBytes.value.toLocaleString()} of ${totalBytes.value.toLocaleString()} bytes sent.`;
    if (phase.value === "paused") return `Upload paused at ${progressBytes.value.toLocaleString()} provider-confirmed bytes.`;
    if (phase.value === "sealing") return "The Worker is independently verifying Gemini size and SHA-256.";
    if (phase.value === "sealed") return "Recording sealed and ready for analysis.";
    if (phase.value === "canceling") return "Abandoning the provider upload session.";
    if (phase.value === "abandoned") return "Upload session abandoned and browser receipt cleared.";
    if (phase.value === "failed") return "Recording transfer needs attention.";
    return "Choose or drop one supported recording.";
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
    draft.value = loadHostedMediaDraft(storage);
    if (draft.value) {
      progressBytes.value = draft.value.offset;
      retention.value = draft.value.retention;
      phase.value = "reselect-required";
      return;
    }
    const sealed = loadMediaResumeReceipt(hostedStorage(storage)).mediaSessionId;
    if (!sealed) {
      phase.value = "idle";
      return;
    }
    try {
      const response = await fetch(`/api/hosted/media/${encodeURIComponent(sealed)}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error("unavailable");
      const value = await response.json() as { media?: HostedMediaView };
      if (!value.media) throw new Error("invalid");
      media.value = value.media;
      phase.value = "sealed";
    } catch {
      clearMediaResumeReceipt(hostedStorage(storage));
      phase.value = "idle";
    }
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
          await reconcileOffset();
          phase.value = "paused";
        } else {
          operationError.value = error instanceof HostedMediaClientError
            ? error.message
            : "Hosted Studio could not transfer this recording.";
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
          ? error.message
          : "Hosted Studio could not abandon the upload session.";
        phase.value = "failed";
      }
    });
  }

  onMounted(() => { void restore(); });
  onBeforeUnmount(() => controller?.abort());

  return {
    busy, cancel, draft, fieldError, fileModel, media, operationError, pause,
    phase, progressBytes, retention, start, statusMessage, totalBytes,
  };
}
