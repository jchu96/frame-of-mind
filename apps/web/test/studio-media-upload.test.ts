import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type {
  MediaPartReceipt,
  MediaSession,
} from "../../../src/domain/studio-schemas";
import {
  MediaUploadClientError,
  clearMediaResumeReceipt,
  loadMediaResumeReceipt,
  persistMediaResumeReceipt,
  uploadMissingMediaParts,
  validateRecordingFile,
  verifyConfirmedMediaParts,
  type MediaStagingTransport,
} from "../server-local/studio-ui/media-upload";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recording(
  bytes: Uint8Array,
  overrides: Partial<Pick<File, "name" | "size" | "type">> = {},
): File {
  return new File([bytes], overrides.name ?? "review.mp4", {
    type: overrides.type ?? "video/mp4",
  });
}

function receipt(
  part: number,
  offset: number,
  bytes: Uint8Array,
): MediaPartReceipt {
  return {
    part,
    offset,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    receivedAt: "2026-07-27T08:00:01.000Z",
  };
}

function session(
  bytes: Uint8Array,
  parts: MediaPartReceipt[] = [],
): MediaSession {
  return {
    id: "media_01K123456789ABC",
    status: parts.length ? "uploading" : "created",
    expectedBytes: bytes.byteLength,
    receivedBytes: parts.reduce((total, part) => total + part.bytes, 0),
    partSizeBytes: 8,
    parts,
    mimeType: "video/mp4",
    retention: { mode: "ephemeral" },
    uploadExpiresAt: "2026-07-28T08:00:00.000Z",
    createdAt: "2026-07-27T08:00:00.000Z",
    updatedAt: "2026-07-27T08:00:01.000Z",
  };
}

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

describe("Studio browser media upload", () => {
  test("validates size, extension, and declared MIME without trusting accept", () => {
    expect(validateRecordingFile({
      name: "walkthrough.MOV",
      size: 512,
      type: "video/quicktime",
    })).toEqual({ ok: true, mimeType: "video/quicktime" });
    expect(validateRecordingFile({
      name: "walkthrough.m4v",
      size: 512,
      type: "video/x-m4v",
    })).toEqual({ ok: true, mimeType: "video/mp4" });

    expect(validateRecordingFile({
      name: "notes.txt",
      size: 512,
      type: "text/plain",
    })).toMatchObject({ ok: false, code: "unsupported_extension" });
    expect(validateRecordingFile({
      name: "walkthrough.mp4",
      size: 512,
      type: "video/webm",
    })).toMatchObject({ ok: false, code: "mime_mismatch" });
    expect(validateRecordingFile({
      name: "empty.mp4",
      size: 0,
      type: "video/mp4",
    })).toMatchObject({ ok: false, code: "empty_file" });
  });

  test("persists only the opaque media ID needed to rediscover an upload", () => {
    const storage = new MemoryStorage();
    persistMediaResumeReceipt(storage, "media_01K123456789ABC");

    expect([...storage.values.values()]).toEqual([
      JSON.stringify({
        schemaVersion: 1,
        mediaSessionId: "media_01K123456789ABC",
      }),
    ]);
    expect(loadMediaResumeReceipt(storage)).toBe("media_01K123456789ABC");

    clearMediaResumeReceipt(storage);
    expect(loadMediaResumeReceipt(storage)).toBeUndefined();
  });

  test("verifies every confirmed part before resuming a reselected file", async () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, index) => index + 1);
    const firstPart = bytes.slice(0, 8);
    const media = session(bytes, [receipt(0, 0, firstPart)]);

    await expect(
      verifyConfirmedMediaParts(recording(bytes), media),
    ).resolves.toBeUndefined();

    const changed = bytes.slice();
    changed[3] ^= 0xff;
    await expect(
      verifyConfirmedMediaParts(recording(changed), media),
    ).rejects.toMatchObject({
      name: "MediaUploadClientError",
      code: "confirmed_part_mismatch",
    });
  });

  test("uploads only missing server-advertised parts and counts confirmed bytes", async () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, index) => index + 1);
    const confirmed = receipt(0, 0, bytes.slice(0, 8));
    let current = session(bytes, [confirmed]);
    const writes: Array<{ part: number; offset: number; bytes: number }> = [];
    const progress: number[] = [];

    const transport: Pick<MediaStagingTransport, "uploadPart"> = {
      async uploadPart(id, part, offset, body) {
        expect(id).toBe(current.id);
        const partBytes = new Uint8Array(await body.arrayBuffer());
        writes.push({ part, offset, bytes: partBytes.byteLength });
        const nextReceipt = receipt(part, offset, partBytes);
        current = {
          ...current,
          status: "uploading",
          receivedBytes: current.receivedBytes + partBytes.byteLength,
          parts: [...current.parts, nextReceipt],
          updatedAt: "2026-07-27T08:00:02.000Z",
        };
        return {
          session: current,
          receipt: nextReceipt,
          replayed: false,
        };
      },
    };

    const result = await uploadMissingMediaParts({
      file: recording(bytes),
      session: current,
      transport,
      onConfirmed: (updated) => progress.push(updated.receivedBytes),
    });

    expect(writes).toEqual([
      { part: 1, offset: 8, bytes: 8 },
      { part: 2, offset: 16, bytes: 4 },
    ]);
    expect(progress).toEqual([16, 20]);
    expect(result.receivedBytes).toBe(20);
  });

  test("fails closed when the reselected file metadata differs", async () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, index) => index + 1);
    const media = session(bytes, [receipt(0, 0, bytes.slice(0, 8))]);

    await expect(
      verifyConfirmedMediaParts(
        recording(bytes.slice(0, 19)),
        media,
      ),
    ).rejects.toBeInstanceOf(MediaUploadClientError);
    await expect(
      verifyConfirmedMediaParts(
        recording(bytes, { name: "review.webm", type: "video/webm" }),
        media,
      ),
    ).rejects.toMatchObject({ code: "file_metadata_mismatch" });
  });
});
