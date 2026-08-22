import { describe, expect, test } from "bun:test";
import type { MediaSession } from "../../../src/domain/studio-schemas";
import {
  loadContextDraft,
  persistContextDraft,
} from "../server-local/studio-ui/context-composer";
import {
  loadIntentDraft,
  persistIntentDraft,
} from "../server-local/studio-ui/intent-composer";
import {
  loadMediaResumeReceipt,
  persistMediaResumeReceipt,
} from "../server-local/studio-ui/media-upload";
import {
  composerReadinessFromStorage,
} from "../server-local/studio-ui/composer-readiness";

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

function media(status: MediaSession["status"]): MediaSession {
  return {
    id: "media_01K123456789ABC",
    status,
    expectedBytes: 20,
    receivedBytes: status === "created" ? 0 : 20,
    partSizeBytes: 8 * 1_024 * 1_024,
    parts: [],
    mimeType: "video/mp4",
    fileFingerprintSha256: "a".repeat(64),
    retention: { mode: "ephemeral", expiresAt: "2026-08-22T12:00:00.000Z" },
    ...(status === "sealed" ? { sha256: "b".repeat(64) } : {}),
    ...(status === "created"
      ? { uploadExpiresAt: "2026-08-22T12:00:00.000Z" }
      : {}),
    createdAt: "2026-08-22T11:00:00.000Z",
    updatedAt: "2026-08-22T11:00:00.000Z",
  };
}

describe("Studio composer readiness", () => {
  test("requires ready Intent and sealed Recording while Context stays optional", () => {
    const storage = new MemoryStorage();
    persistIntentDraft(storage, {
      recipe: {
        id: "requirements",
        revision: "builtin-2026-07-27.1",
      },
      model: "gemini-3.7-flash",
    });

    expect(composerReadinessFromStorage(storage, media("created"))).toEqual({
      intent: "ready",
      context: "none",
      recording: "staging",
      canRun: false,
    });
    expect(composerReadinessFromStorage(storage, media("sealed"))).toEqual({
      intent: "ready",
      context: "none",
      recording: "sealed",
      canRun: true,
    });
  });

  test("preserves Intent and Context when media is deleted or expires", () => {
    const storage = new MemoryStorage();
    persistIntentDraft(storage, {
      recipe: {
        id: "decisions",
        revision: "builtin-2026-07-27.1",
      },
      focus: "Capture explicit rationale.",
      model: "gemini-3.7-flash",
    });
    persistContextDraft(storage, {
      schemaVersion: 2,
      mode: "enriched",
      context: {
        provider: "bluedot",
        transport: "mcp",
        meetingId: "synthetic-meeting",
      },
      committed: true,
    });

    expect(composerReadinessFromStorage(storage, media("sealed"))).toEqual({
      intent: "ready",
      context: "committed",
      recording: "sealed",
      canRun: true,
    });
    expect(composerReadinessFromStorage(storage, undefined)).toEqual({
      intent: "ready",
      context: "committed",
      recording: "empty",
      canRun: false,
    });
  });

  test("reports intentional video-only context without inferring it from absence", () => {
    const storage = new MemoryStorage();
    expect(composerReadinessFromStorage(storage, undefined).context).toBe("none");
    persistContextDraft(storage, {
      schemaVersion: 2,
      mode: "video-only",
      committed: true,
    });
    expect(composerReadinessFromStorage(storage, undefined).context)
      .toBe("video-only");
  });

  test("preserves all composer steps persisted in non-canonical order", () => {
    const storage = new MemoryStorage();
    const intent = {
      recipe: {
        id: "requirements",
        revision: "builtin-2026-07-27.1",
      },
      focus: "Preserve order-independent state.",
      model: "gemini-3.7-flash",
    };
    const context = {
      schemaVersion: 2 as const,
      mode: "enriched" as const,
      context: {
        provider: "bluedot" as const,
        transport: "mcp" as const,
        meetingId: "synthetic-meeting",
      },
      committed: true,
    };
    const sealedMedia = media("sealed");

    expect(persistIntentDraft(storage, intent)).toBe(true);
    expect(persistContextDraft(storage, context)).toBe(true);
    expect(persistMediaResumeReceipt(storage, sealedMedia.id)).toBe(true);

    expect(loadIntentDraft(storage).draft).toEqual(intent);
    expect(loadContextDraft(storage).draft).toEqual(context);
    expect(loadMediaResumeReceipt(storage).mediaSessionId).toBe(sealedMedia.id);
    expect(composerReadinessFromStorage(storage, sealedMedia)).toEqual({
      intent: "ready",
      context: "committed",
      recording: "sealed",
      canRun: true,
    });
  });
});
