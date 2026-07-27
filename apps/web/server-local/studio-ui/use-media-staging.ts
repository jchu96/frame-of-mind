import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from "vue";
import type {
  MediaCreateRequest,
  MediaSession,
} from "../../../../src/domain/studio-schemas";
import {
  MediaUploadClientError,
  clearMediaResumeReceipt,
  createMediaStagingTransport,
  loadMediaResumeReceipt,
  persistMediaResumeReceipt,
  uploadMissingMediaParts,
  validateRecordingFile,
} from "./media-upload";

export type MediaUploadPhase =
  | "idle"
  | "restoring"
  | "selected"
  | "creating"
  | "verifying"
  | "uploading"
  | "pausing"
  | "paused"
  | "reselect-required"
  | "ready-to-resume"
  | "mismatch"
  | "sealing"
  | "sealed"
  | "aborting"
  | "aborted"
  | "failed";

const activeServerStates = new Set(["created", "uploading"]);
const usableServerStates = new Set(["sealed", "in_use", "retained"]);

function messageFor(error: unknown): string {
  if (error instanceof MediaUploadClientError) return error.message;
  if (error instanceof Error && error.name === "AbortError") {
    return "Upload paused after the last server-confirmed part.";
  }
  return "The local Studio could not stage this recording. Try again.";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useMediaStaging() {
  const transport = createMediaStagingTransport();
  const selectedFile = shallowRef<File | null>(null);
  const session = shallowRef<MediaSession | null>(null);
  const phase = ref<MediaUploadPhase>("idle");
  const fieldError = ref<string>();
  const operationError = ref<string>();
  const retentionMode = ref<"ephemeral" | "retained">("ephemeral");
  const retentionTtlSeconds = ref(24 * 60 * 60);
  let controller: AbortController | undefined;
  let activeOperation: Promise<void> | undefined;

  const progressBytes = computed(() => session.value?.receivedBytes ?? 0);
  const totalBytes = computed(
    () => session.value?.expectedBytes ?? selectedFile.value?.size ?? 0,
  );
  const progressPercent = computed(() => totalBytes.value
    ? Math.round((progressBytes.value / totalBytes.value) * 100)
    : 0);
  const hasActiveSession = computed(
    () => Boolean(session.value && activeServerStates.has(session.value.status)),
  );
  const busy = computed(() => [
    "restoring",
    "creating",
    "verifying",
    "uploading",
    "pausing",
    "sealing",
    "aborting",
  ].includes(phase.value));

  const statusMessage = computed(() => {
    switch (phase.value) {
      case "restoring":
        return "Checking for an unfinished local upload.";
      case "selected":
        return "Recording selected. Review retention before staging.";
      case "creating":
        return "Reserving private local staging space.";
      case "verifying":
        return "Verifying previously confirmed recording parts.";
      case "uploading":
        return `${progressPercent.value}% staged locally; ${progressBytes.value} of ${totalBytes.value} bytes confirmed.`;
      case "pausing":
        return "Pausing after the current request stops.";
      case "paused":
        return `Upload paused with ${progressBytes.value} bytes confirmed by the server.`;
      case "reselect-required":
        return "An unfinished upload was found. Reselect the same recording to resume.";
      case "ready-to-resume":
        return "Recording metadata matches. Resume to verify confirmed parts.";
      case "mismatch":
        return "The selected recording does not match this upload.";
      case "sealing":
        return "All parts are confirmed. Verifying and sealing the recording.";
      case "sealed":
        return "Recording staged and sealed locally.";
      case "aborting":
        return "Deleting the private staged copy.";
      case "aborted":
        return "Staged recording deleted.";
      case "failed":
        return "Staging needs attention.";
      default:
        return "Choose or drop one supported recording.";
    }
  });

  function selectFile(file: File | null | undefined): void {
    if (busy.value) return;
    selectedFile.value = file ?? null;
    fieldError.value = undefined;
    operationError.value = undefined;

    if (!file) {
      phase.value = hasActiveSession.value ? "reselect-required" : "idle";
      return;
    }

    const validation = validateRecordingFile(file);
    if (!validation.ok) {
      fieldError.value = validation.message;
      phase.value = session.value ? "mismatch" : "idle";
      return;
    }

    if (session.value && activeServerStates.has(session.value.status)) {
      if (
        file.size !== session.value.expectedBytes
        || validation.mimeType !== session.value.mimeType
      ) {
        fieldError.value = "Choose the same recording, or restart this upload.";
        phase.value = "mismatch";
      } else {
        phase.value = "ready-to-resume";
      }
      return;
    }

    phase.value = "selected";
  }

  const fileModel = computed<File | null>({
    get: () => selectedFile.value,
    set: selectFile,
  });

  async function restore(): Promise<void> {
    const id = loadMediaResumeReceipt(sessionStorage);
    if (!id) return;
    phase.value = "restoring";
    try {
      const restored = await transport.status(id);
      session.value = restored;
      if (activeServerStates.has(restored.status)) {
        phase.value = "reselect-required";
      } else if (usableServerStates.has(restored.status)) {
        phase.value = "sealed";
      } else if (restored.status === "cleanup_failed") {
        operationError.value =
          "The staged bytes could not be deleted. Retry deletion before continuing.";
        phase.value = "failed";
      } else {
        clearMediaResumeReceipt(sessionStorage);
        phase.value = ["aborted", "deleted"].includes(restored.status)
          ? "aborted"
          : "idle";
      }
    } catch (error) {
      if (error instanceof MediaUploadClientError && error.status === 404) {
        clearMediaResumeReceipt(sessionStorage);
        phase.value = "idle";
        return;
      }
      operationError.value = messageFor(error);
      phase.value = "failed";
    }
  }

  function runExclusive(work: () => Promise<void>): Promise<void> {
    if (activeOperation) return activeOperation;
    activeOperation = work().finally(() => {
      activeOperation = undefined;
    });
    return activeOperation;
  }

  async function reconcileAfterPause(): Promise<void> {
    if (!session.value) return;
    try {
      session.value = await transport.status(session.value.id);
      phase.value = selectedFile.value ? "paused" : "reselect-required";
    } catch (error) {
      operationError.value = messageFor(error);
      phase.value = "failed";
    }
  }

  async function uploadAndSeal(): Promise<void> {
    if (!selectedFile.value || !session.value) return;
    controller = new AbortController();
    operationError.value = undefined;
    phase.value = session.value.parts.length ? "verifying" : "uploading";
    try {
      session.value = await uploadMissingMediaParts({
        file: selectedFile.value,
        session: session.value,
        transport,
        signal: controller.signal,
        onConfirmed: (confirmed) => {
          session.value = confirmed;
          phase.value = "uploading";
        },
      });
      phase.value = "sealing";
      session.value = await transport.complete(
        session.value.id,
        controller.signal,
      );
      phase.value = "sealed";
    } catch (error) {
      if (isAbort(error)) {
        await reconcileAfterPause();
      } else if (
        error instanceof MediaUploadClientError
        && [
          "confirmed_part_mismatch",
          "file_metadata_mismatch",
        ].includes(error.code)
      ) {
        fieldError.value = error.message;
        phase.value = "mismatch";
      } else {
        operationError.value = messageFor(error);
        phase.value = "failed";
      }
    } finally {
      controller = undefined;
    }
  }

  function start(): Promise<void> {
    return runExclusive(async () => {
      const file = selectedFile.value;
      if (!file) {
        fieldError.value = "Choose a recording before staging.";
        return;
      }
      const validation = validateRecordingFile(file);
      if (!validation.ok) {
        fieldError.value = validation.message;
        return;
      }

      phase.value = "creating";
      operationError.value = undefined;
      controller = new AbortController();
      const retention: MediaCreateRequest["retention"] =
        retentionMode.value === "retained"
          ? { mode: "retained", ttlSeconds: retentionTtlSeconds.value }
          : { mode: "ephemeral" };
      try {
        session.value = await transport.create({
          idempotencyKey: crypto.randomUUID(),
          expectedBytes: file.size,
          mimeType: validation.mimeType,
          retention,
        }, controller.signal);
        persistMediaResumeReceipt(sessionStorage, session.value.id);
      } catch (error) {
        if (isAbort(error)) {
          phase.value = "selected";
        } else {
          operationError.value = messageFor(error);
          phase.value = "failed";
        }
        controller = undefined;
        return;
      }
      controller = undefined;
      await uploadAndSeal();
    });
  }

  function resume(): Promise<void> {
    return runExclusive(uploadAndSeal);
  }

  function pause(): void {
    if (!controller) return;
    phase.value = "pausing";
    controller.abort();
  }

  function abortStaging(): Promise<void> {
    const pending = activeOperation;
    controller?.abort();
    return (async () => {
      await pending;
      return runExclusive(async () => {
        if (!session.value) return;
        phase.value = "aborting";
        operationError.value = undefined;
        try {
          session.value = await transport.abort(session.value.id);
          if (["aborted", "deleted"].includes(session.value.status)) {
            clearMediaResumeReceipt(sessionStorage);
            phase.value = "aborted";
          } else {
            operationError.value =
              "The staged bytes could not be deleted. Retry deletion.";
            phase.value = "failed";
          }
        } catch (error) {
          operationError.value = messageFor(error);
          phase.value = "failed";
        }
      });
    })();
  }

  async function restart(): Promise<void> {
    await abortStaging();
    if (
      !session.value
      || !["aborted", "deleted"].includes(session.value.status)
    ) return;
    session.value = null;
    phase.value = selectedFile.value ? "selected" : "idle";
    await start();
  }

  onMounted(() => {
    void restore();
  });
  onBeforeUnmount(() => {
    controller?.abort();
  });

  return {
    abortStaging,
    busy,
    fileModel,
    fieldError,
    hasActiveSession,
    operationError,
    pause,
    phase,
    progressBytes,
    progressPercent,
    restart,
    resume,
    retentionMode,
    retentionTtlSeconds,
    selectedFile,
    session,
    start,
    statusMessage,
    totalBytes,
  };
}
