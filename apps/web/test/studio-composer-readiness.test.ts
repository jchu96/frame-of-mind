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
  refreshComposerReadiness,
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

  test("preserves all composer steps persisted in non-canonical order", async () => {
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
    const permutations = [
      ["intent", "context", "media"],
      ["media", "context", "intent"],
      ["context", "media", "intent"],
    ] as const;

    for (const order of permutations) {
      const storage = new MemoryStorage();
      const persist = {
        intent: () => persistIntentDraft(storage, intent),
        context: () => persistContextDraft(storage, context),
        media: () => persistMediaResumeReceipt(storage, sealedMedia.id),
      };
      for (const step of order) expect(persist[step]()).toBe(true);

      expect(loadIntentDraft(storage).draft).toEqual(intent);
      expect(loadContextDraft(storage).draft).toEqual(context);
      expect(loadMediaResumeReceipt(storage).mediaSessionId).toBe(sealedMedia.id);
      const next = await refreshComposerReadiness(
        storage,
        {
          intent: "empty",
          context: "none",
          recording: "empty",
          canRun: false,
        },
        {
          async status(id) {
            expect(id).toBe(sealedMedia.id);
            return sealedMedia;
          },
        },
      );
      expect(next).toEqual({
        intent: "ready",
        context: "committed",
        recording: "sealed",
        canRun: true,
      });
    }
  });

  test("keeps canRun false for a custom-recipe draft even with sealed media", () => {
    const storage = new MemoryStorage();
    persistIntentDraft(storage, {
      recipe: {
        custom: {
          id: "synthetic-review",
          label: "Synthetic review",
          description: "Review an invented fixture.",
          indexInstruction: "Find relevant synthetic moments.",
          interrogationInstruction: "Verify each synthetic moment.",
        },
      },
      model: "gemini-3.7-flash",
    });

    expect(composerReadinessFromStorage(storage, media("sealed"))).toEqual({
      intent: "draft",
      context: "none",
      recording: "sealed",
      canRun: false,
    });
  });

  test("refresh() keeps a prior sealed recording when the status GET fails", async () => {
    const storage = new MemoryStorage();
    persistIntentDraft(storage, {
      recipe: {
        id: "requirements",
        revision: "builtin-2026-07-27.1",
      },
      model: "gemini-3.7-flash",
    });
    persistMediaResumeReceipt(storage, "media_01K123456789ABC");
    const prior = composerReadinessFromStorage(storage, media("sealed"));
    expect(prior).toEqual({
      intent: "ready",
      context: "none",
      recording: "sealed",
      canRun: true,
    });

    const next = await refreshComposerReadiness(
      storage,
      prior,
      {
        async status() {
          throw new Error("Synthetic media status failure.");
        },
      },
    );
    expect(next.recording).toBe("sealed");
    expect(next.canRun).toBe(true);
    expect(next.intent).toBe("ready");
  });

  test("preserves the prior recording slice when the status GET fails", async () => {
    const storage = new MemoryStorage();
    persistMediaResumeReceipt(storage, "media_01K123456789ABC");
    const next = await refreshComposerReadiness(
      storage,
      {
        intent: "empty",
        context: "none",
        recording: "empty",
        canRun: false,
      },
      {
        async status() {
          throw new Error("Synthetic media status failure.");
        },
      },
    );
    expect(next.recording).toBe("empty");
    expect(next.canRun).toBe(false);
  });
});
