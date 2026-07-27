import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MEDIA_PART_SIZE_BYTES,
  type MediaCreateRequest,
  type MediaSession,
} from "../../../src/domain/studio-schemas";
import {
  fingerprintRecordingFile,
  MediaUploadClientError,
  type MediaStagingTransport,
} from "../server-local/studio-ui/media-upload";
import { useMediaStaging } from "../server-local/studio-ui/use-media-staging";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function mp4(name = "review.mp4", changedTail = false): File {
  const bytes = new Uint8Array(20);
  bytes.set([0, 0, 0, 24]);
  bytes.set(new TextEncoder().encode("ftypisom"), 4);
  for (let index = 12; index < bytes.length; index += 1) {
    bytes[index] = index;
  }
  if (changedTail) bytes[19] ^= 0xff;
  return new File([bytes], name, { type: "video/mp4" });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sessionFrom(
  input: MediaCreateRequest,
  status: MediaSession["status"] = "created",
): MediaSession {
  return {
    id: "media_01K123456789ABC",
    status,
    expectedBytes: input.expectedBytes,
    receivedBytes: 0,
    partSizeBytes: DEFAULT_MEDIA_PART_SIZE_BYTES,
    parts: [],
    mimeType: input.mimeType,
    fileFingerprintSha256: input.fileFingerprintSha256,
    retention: {
      mode: "ephemeral",
      expiresAt: "2026-07-28T08:00:00.000Z",
    },
    uploadExpiresAt: ["created", "uploading"].includes(status)
      ? "2026-07-28T08:00:00.000Z"
      : undefined,
    createdAt: "2026-07-27T08:00:00.000Z",
    updatedAt: "2026-07-27T08:00:00.000Z",
  };
}

function transportHarness(overrides: Partial<MediaStagingTransport> = {}) {
  let current: MediaSession | undefined;
  const transport: MediaStagingTransport = {
    async create(input) {
      current = sessionFrom(input);
      return current;
    },
    async status() {
      if (!current) throw new Error("No media session.");
      return current;
    },
    async uploadPart(id, part, offset, body) {
      if (!current || current.id !== id) throw new Error("No media session.");
      const bytes = new Uint8Array(await body.arrayBuffer());
      const receipt = {
        part,
        offset,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        receivedAt: "2026-07-27T08:00:01.000Z",
      };
      current = {
        ...current,
        status: "uploading",
        receivedBytes: current.receivedBytes + bytes.byteLength,
        parts: [...current.parts, receipt],
        updatedAt: receipt.receivedAt,
      };
      return { session: current, receipt, replayed: false };
    },
    async complete() {
      if (!current) throw new Error("No media session.");
      current = {
        ...current,
        status: "sealed",
        sha256: "a".repeat(64),
        uploadExpiresAt: undefined,
        updatedAt: "2026-07-27T08:00:02.000Z",
      };
      return current;
    },
    async abort() {
      if (!current) throw new Error("No media session.");
      current = {
        ...current,
        status: "deleted",
        uploadExpiresAt: undefined,
        updatedAt: "2026-07-27T08:00:03.000Z",
      };
      return current;
    },
    ...overrides,
  };
  return {
    get current() {
      return current;
    },
    set current(value: MediaSession | undefined) {
      current = value;
    },
    transport,
  };
}

describe("Studio media staging controller", () => {
  test("reuses one create key after an ambiguous response", async () => {
    const keys: string[] = [];
    let attempts = 0;
    const harness = transportHarness({
      async create(input) {
        keys.push(input.idempotencyKey);
        attempts += 1;
        if (attempts === 1) throw new TypeError("connection reset");
        harness.current = sessionFrom(input);
        return harness.current;
      },
    });
    const controller = useMediaStaging({
      transport: harness.transport,
      storage: new MemoryStorage(),
      mountLifecycle: false,
    });
    controller.fileModel.value = mp4();

    await controller.start();
    expect(controller.phase.value).toBe("failed");
    expect(controller.selectionLocked.value).toBe(true);
    await controller.start();

    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(controller.phase.value).toBe("sealed");
  });

  test("pauses an active request, reconciles, and resumes confirmed work", async () => {
    let blockNextPart = true;
    let signalPartStarted: (() => void) | undefined;
    const partStarted = new Promise<void>((resolve) => {
      signalPartStarted = resolve;
    });
    const harness = transportHarness();
    const file = mp4();
    const input: MediaCreateRequest = {
      idempotencyKey: "controller-pause-0001",
      expectedBytes: file.size,
      mimeType: "video/mp4",
      fileFingerprintSha256: await fingerprintRecordingFile(file),
      retention: { mode: "ephemeral" },
    };
    harness.current = sessionFrom(input, "uploading");
    harness.transport.uploadPart = async (id, part, offset, body, mime, signal) => {
      if (blockNextPart) {
        blockNextPart = false;
        signalPartStarted?.();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("paused", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new DOMException("paused", "AbortError"));
          }, { once: true });
        });
      }
      const bytes = new Uint8Array(await body.arrayBuffer());
      const receipt = {
        part,
        offset,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        receivedAt: "2026-07-27T08:00:01.000Z",
      };
      harness.current = {
        ...harness.current!,
        status: "uploading",
        receivedBytes: bytes.byteLength,
        parts: [receipt],
        updatedAt: receipt.receivedAt,
      };
      void id;
      void mime;
      return { session: harness.current, receipt, replayed: false };
    };
    const controller = useMediaStaging({
      transport: harness.transport,
      storage: new MemoryStorage(),
      mountLifecycle: false,
    });
    controller.session.value = harness.current;
    controller.fileModel.value = file;

    const pending = controller.resume();
    await partStarted;
    expect(controller.phase.value).toBe("uploading");
    controller.pause();
    await pending;
    expect(controller.phase.value).toBe("paused");

    await controller.resume();
    expect(controller.phase.value).toBe("sealed");
  });

  test("preserves cleanup failures and retries deletion explicitly", async () => {
    let attempts = 0;
    const input: MediaCreateRequest = {
      idempotencyKey: "controller-delete-0001",
      expectedBytes: 20,
      mimeType: "video/mp4",
      retention: { mode: "ephemeral" },
    };
    const harness = transportHarness({
      async abort() {
        attempts += 1;
        if (attempts === 1) {
          throw new MediaUploadClientError(
            "http_503",
            "Staged media cleanup failed and can be retried.",
            503,
          );
        }
        harness.current = {
          ...harness.current!,
          status: "deleted",
          cleanupFailureCode: undefined,
          updatedAt: "2026-07-27T08:00:03.000Z",
        };
        return harness.current;
      },
    });
    harness.current = {
      ...sessionFrom(input, "cleanup_failed"),
      cleanupFailureCode: "eacces",
    };
    const controller = useMediaStaging({
      transport: harness.transport,
      storage: new MemoryStorage(),
      mountLifecycle: false,
    });
    controller.session.value = harness.current;

    await controller.abortStaging();
    expect(controller.phase.value).toBe("failed");
    expect(controller.session.value?.status).toBe("cleanup_failed");
    await controller.abortStaging();
    expect(controller.phase.value).toBe("aborted");
    expect(controller.session.value).toBeNull();
  });

  test("deletes a mismatched upload before starting the replacement", async () => {
    const original = mp4("original.mp4");
    const replacement = mp4("replacement.mp4", true);
    const originalInput: MediaCreateRequest = {
      idempotencyKey: "controller-mismatch-0001",
      expectedBytes: original.size,
      mimeType: "video/mp4",
      fileFingerprintSha256: await fingerprintRecordingFile(original),
      retention: { mode: "ephemeral" },
    };
    const actions: string[] = [];
    const harness = transportHarness({
      async create(input) {
        actions.push("create");
        harness.current = sessionFrom(input);
        return harness.current;
      },
      async abort() {
        actions.push("delete");
        harness.current = {
          ...harness.current!,
          status: "deleted",
          uploadExpiresAt: undefined,
        };
        return harness.current;
      },
    });
    harness.current = sessionFrom(originalInput, "uploading");
    const controller = useMediaStaging({
      transport: harness.transport,
      storage: new MemoryStorage(),
      mountLifecycle: false,
    });
    controller.session.value = harness.current;
    controller.fileModel.value = replacement;

    await controller.resume();
    expect(controller.phase.value).toBe("mismatch");
    await controller.restart();
    expect(actions.slice(0, 2)).toEqual(["delete", "create"]);
    expect(controller.phase.value).toBe("sealed");
  });
});
