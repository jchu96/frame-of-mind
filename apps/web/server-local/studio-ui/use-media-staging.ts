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
  fingerprintRecordingFile,
  loadMediaResumeReceipt,
  persistMediaResumeReceipt,
  uploadMissingMediaParts,
  validateRecordingFile,
  type MediaStagingTransport,
} from "./media-upload";

export type MediaUploadPhase =
  | "idle"
  | "restoring"
  | "selected"
  | "fingerprinting"
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
const replacementLockedServerStates = new Set([
  ...usableServerStates,
  "cleanup_failed",
  "failed",
]);

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface MediaStagingOptions {
  transport?: MediaStagingTransport;
  storage?: BrowserStorage;
  mountLifecycle?: boolean;
}

const unavailableStorage: BrowserStorage = {
  getItem() {
    throw new Error("Browser session storage is unavailable.");
  },
  setItem() {
    throw new Error("Browser session storage is unavailable.");
  },
  removeItem() {
    throw new Error("Browser session storage is unavailable.");
  },
};

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

export function useMediaStaging(options: MediaStagingOptions = {}) {
  const transport = options.transport ?? createMediaStagingTransport();
  const storage = options.storage
    ?? (typeof sessionStorage === "undefined"
      ? unavailableStorage
      : sessionStorage);
  const selectedFile = shallowRef<File | null>(null);
  const session = shallowRef<MediaSession | null>(null);
  const phase = ref<MediaUploadPhase>("idle");
  const fieldError = ref<string>();
  const operationError = ref<string>();
  const resumeWarning = ref<string>();
  const ambiguousCreate = ref(false);
  const retentionMode = ref<"ephemeral" | "retained">("ephemeral");
  const retentionTtlSeconds = ref(24 * 60 * 60);
  let controller: AbortController | undefined;
  let activeOperation: Promise<void> | undefined;
  let pendingCreate: MediaCreateRequest | undefined;

  const progressBytes = computed(() => session.value?.receivedBytes ?? 0);
  const totalBytes = computed(
    () => session.value?.expectedBytes ?? selectedFile.value?.size ?? 0,
  );
  const progressPercent = computed(() => {
    if (!totalBytes.value) return 0;
    if (progressBytes.value >= totalBytes.value) return 100;
    return Math.floor((progressBytes.value / totalBytes.value) * 100);
  });
  const hasActiveSession = computed(
    () => Boolean(session.value && activeServerStates.has(session.value.status)),
  );
  const busy = computed(() => [
    "restoring",
    "fingerprinting",
    "creating",
    "verifying",
    "uploading",
    "pausing",
    "sealing",
    "aborting",
  ].includes(phase.value));
  const selectionLocked = computed(() => (
    ambiguousCreate.value
    || Boolean(
      session.value
      && replacementLockedServerStates.has(session.value.status),
    )
  ));

  const statusMessage = computed(() => {
    switch (phase.value) {
      case "restoring":
        return "Checking for an unfinished local upload.";
      case "selected":
        return "Recording selected. Review retention before staging.";
      case "fingerprinting":
        return "Binding this exact recording to its private upload session.";
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
    if (busy.value || ambiguousCreate.value) return;
    if (
      file
      && session.value
      && replacementLockedServerStates.has(session.value.status)
    ) {
      fieldError.value =
        "Delete the current staged copy before choosing another recording.";
      return;
    }
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
    const receipt = loadMediaResumeReceipt(storage);
    if (!receipt.storageAvailable) {
      resumeWarning.value =
        "Browser session storage is unavailable. Current staging can continue, but refresh-resume is disabled.";
    }
    const id = receipt.mediaSessionId;
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
      } else if (restored.status === "failed") {
        operationError.value =
          "The server marked this media as failed and may still hold bytes. Keep this receipt for manual remediation.";
        phase.value = "failed";
      } else {
        if (!clearMediaResumeReceipt(storage)) {
          resumeWarning.value =
            "The completed browser receipt could not be cleared. The server state remains authoritative.";
        }
        phase.value = ["aborted", "deleted"].includes(restored.status)
          ? "aborted"
          : "idle";
        session.value = null;
      }
    } catch (error) {
      if (error instanceof MediaUploadClientError && error.status === 404) {
        if (!clearMediaResumeReceipt(storage)) {
          resumeWarning.value =
            "The stale browser receipt could not be cleared.";
        }
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
      const reconciled = await transport.status(session.value.id);
      session.value = reconciled;
      if (activeServerStates.has(reconciled.status)) {
        phase.value = selectedFile.value ? "paused" : "reselect-required";
      } else if (usableServerStates.has(reconciled.status)) {
        phase.value = "sealed";
      } else if (reconciled.status === "cleanup_failed") {
        operationError.value =
          "The staged bytes could not be deleted. Retry deletion.";
        phase.value = "failed";
      } else if (reconciled.status === "failed") {
        operationError.value =
          "The server marked this media as failed and may still hold bytes.";
        phase.value = "failed";
      } else {
        phase.value = "aborted";
      }
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
          "file_fingerprint_mismatch",
          "file_metadata_mismatch",
          "resume_identity_unavailable",
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

      operationError.value = undefined;
      controller = new AbortController();
      let createRequested = false;
      try {
        if (!pendingCreate) {
          phase.value = "fingerprinting";
          const fileFingerprintSha256 = await fingerprintRecordingFile(
            file,
            undefined,
            controller.signal,
          );
          const retention: MediaCreateRequest["retention"] =
            retentionMode.value === "retained"
              ? { mode: "retained", ttlSeconds: retentionTtlSeconds.value }
              : { mode: "ephemeral" };
          pendingCreate = {
            idempotencyKey: crypto.randomUUID(),
            expectedBytes: file.size,
            mimeType: validation.mimeType,
            fileFingerprintSha256,
            retention,
          };
        }
        phase.value = "creating";
        createRequested = true;
        session.value = await transport.create(
          pendingCreate,
          controller.signal,
        );
        pendingCreate = undefined;
        ambiguousCreate.value = false;
        if (!persistMediaResumeReceipt(storage, session.value.id)) {
          resumeWarning.value =
            "Browser session storage is unavailable. This upload cannot resume after a refresh; keep this page open or delete the staged copy.";
        }
      } catch (error) {
        const definitiveHttpFailure = error instanceof MediaUploadClientError;
        if (definitiveHttpFailure) pendingCreate = undefined;
        ambiguousCreate.value = createRequested && !definitiveHttpFailure;
        if (isAbort(error)) {
          phase.value = ambiguousCreate.value ? "failed" : "selected";
          if (ambiguousCreate.value) {
            operationError.value =
              "Creation may have reached the local server. Retry with the same request before changing the recording.";
          }
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
    if (!controller || phase.value === "sealing") return;
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
          const deleted = await transport.abort(session.value.id);
          if (["aborted", "deleted"].includes(deleted.status)) {
            if (!clearMediaResumeReceipt(storage)) {
              resumeWarning.value =
                "The browser receipt could not be cleared, but the server confirmed deletion.";
            }
            session.value = null;
            phase.value = "aborted";
          } else {
            session.value = deleted;
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
    if (session.value) return;
    phase.value = selectedFile.value ? "selected" : "idle";
    await start();
  }

  if (options.mountLifecycle !== false) {
    onMounted(() => {
      void restore();
    });
    onBeforeUnmount(() => {
      controller?.abort();
    });
  }

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
    resumeWarning,
    retentionMode,
    retentionTtlSeconds,
    restore,
    selectionLocked,
    selectedFile,
    session,
    start,
    statusMessage,
    totalBytes,
  };
}
