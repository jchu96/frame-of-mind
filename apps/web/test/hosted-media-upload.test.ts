import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  HOSTED_MEDIA_DRAFT_KEY,
  loadHostedMediaDraft,
  uploadHostedRecording,
  withHostedUploadLock,
  type HostedMediaDraft,
} from "../server-hosted/studio-ui/hosted-media-upload";
import {
  HOSTED_HASH_SLICE_BYTES,
  hashBlobIncrementally,
} from "../server-hosted/studio-ui/hosted-sha256";

const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;
const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
  if (originalLocks) Object.defineProperty(globalThis.navigator, "locks", originalLocks);
  else Reflect.deleteProperty(globalThis.navigator, "locks");
});

describe("hosted direct media upload", () => {
  test("incremental browser hash agrees with the independent SHA-256 oracle", async () => {
    const bytes = fixtureBytes(HOSTED_HASH_SLICE_BYTES + 17);
    const progress: number[] = [];
    const actual = await hashBlobIncrementally(
      new Blob([bytes]),
      (value) => progress.push(value),
    );

    expect(actual).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(progress).toEqual([HOSTED_HASH_SLICE_BYTES, bytes.length]);
  });

  test("reload resume trusts provider query offset before sending another part", async () => {
    const file = new File([fixtureBytes(700_123)], "recording.webm", {
      type: "video/webm",
    });
    const draft = uploadDraft(file.size);
    const requests: Array<{ offset: string | null; command: string | null; size: number }> = [];
    globalThis.fetch = (async () => new Response(null, {
      status: 200,
      headers: { "x-goog-upload-size-received": String(draft.partBytes) },
    })) as typeof fetch;
    globalThis.XMLHttpRequest = class {
      status = 200;
      timeout = 0;
      upload = { onprogress: undefined as ((event: { loaded: number }) => void) | undefined };
      onload?: () => void;
      onerror?: () => void;
      ontimeout?: () => void;
      onabort?: () => void;
      private headers = new Map<string, string>();
      open() {}
      setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
      abort() { this.onabort?.(); }
      send(body: Blob) {
        requests.push({
          offset: this.headers.get("x-goog-upload-offset") ?? null,
          command: this.headers.get("x-goog-upload-command") ?? null,
          size: body.size,
        });
        this.upload.onprogress?.({ loaded: body.size });
        queueMicrotask(() => this.onload?.());
      }
    } as unknown as typeof XMLHttpRequest;

    const confirmed: number[] = [];
    await uploadHostedRecording({
      file,
      draft,
      onProgress: () => undefined,
      onConfirmed: (offset) => confirmed.push(offset),
    });

    expect(requests[0]).toEqual({
      offset: String(draft.partBytes),
      command: "upload",
      size: draft.partBytes,
    });
    expect(requests.at(-1)?.command).toBe("upload, finalize");
    expect(confirmed).toEqual([draft.partBytes, draft.partBytes * 2, file.size]);
  });

  test("malformed session storage drafts fail closed and are removed", () => {
    let removed = "";
    const result = loadHostedMediaDraft({
      getItem: () => JSON.stringify({ schemaVersion: 1, uploadUrl: "https://example.test/?key=leak" }),
      removeItem: (key) => { removed = key; },
    });
    expect(result).toBeUndefined();
    expect(removed).toBe(HOSTED_MEDIA_DRAFT_KEY);
  });

  test("a complete persisted upload draft survives reload validation", () => {
    const draft = uploadDraft(700_123);
    const result = loadHostedMediaDraft({
      getItem: () => JSON.stringify(draft),
      removeItem: () => { throw new Error("valid draft was removed"); },
    });
    expect(result).toEqual(draft);
  });

  test("a successful void upload is not mistaken for a denied Web Lock", async () => {
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => {
          return await callback({});
        },
      },
    });
    let ran = false;
    await withHostedUploadLock("media_1234567890abcdef", async () => { ran = true; });
    expect(ran).toBe(true);
  });

  test("a second tab denied the upload lock fails visibly", async () => {
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: (lock: null) => Promise<unknown>) => {
          return await callback(null);
        },
      },
    });
    await expect(withHostedUploadLock("media_1234567890abcdef", async () => undefined))
      .rejects.toThrow("already active in another tab");
  });
});

function uploadDraft(size: number): HostedMediaDraft {
  return {
    schemaVersion: 1,
    mediaId: "media_1234567890abcdef",
    uploadUrl: "https://generativelanguage.googleapis.test/upload?upload_protocol=resumable&upload_id=test",
    partBytes: 256 * 1_024,
    sessionExpiresAt: "2026-08-23T12:00:00.000Z",
    declaredSizeBytes: size,
    declaredSha256: "a".repeat(64),
    mimeType: "video/webm",
    durationSeconds: 3,
    retention: "ephemeral",
    offset: 0,
  };
}

function fixtureBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) value[index] = (index * 29 + 7) % 251;
  return value;
}
