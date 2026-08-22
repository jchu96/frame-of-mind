import { describe, expect, test } from "bun:test";
import type { MediaSession } from "../../../src/domain/studio-schemas";
import {
  buildComposerPayload,
  canStartRunAnalysis,
  clearRunDraft,
  createOrLoadRunDraft,
  deriveRunReceiptState,
  runRetentionDisplay,
  retentionRequestForMediaSession,
  runFieldErrorForJobCode,
  RUN_DRAFT_STORAGE_KEY,
  startFreshRunReceipt,
} from "../server-local/studio-ui/run-composer";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function media(status: MediaSession["status"] = "sealed"): MediaSession {
  return {
    id: "media_01K123456789ABC",
    status,
    expectedBytes: 64,
    receivedBytes: 64,
    partSizeBytes: 8 * 1_024 * 1_024,
    parts: [],
    mimeType: "video/mp4",
    sha256: "a".repeat(64),
    retention: {
      mode: "ephemeral",
      expiresAt: "2026-08-22T13:00:00.000Z",
    },
    createdAt: "2026-08-22T11:00:00.000Z",
    updatedAt: "2026-08-22T11:05:00.000Z",
  };
}

const intent = {
  recipe: { id: "requirements", revision: "builtin-2026-07-27.1" },
  focus: "Prioritize acceptance criteria.",
  model: "gemini-3.7-flash",
};
const recipes = [{
  id: "requirements",
  label: "Requirements",
  revision: "builtin-2026-07-27.1",
}];
const videoOnly = {
  schemaVersion: 2 as const,
  mode: "video-only" as const,
  committed: true as const,
};

describe("Studio Run receipt state", () => {
  test("enables submission only for ready intent, sealed media, and explicit context", () => {
    const state = deriveRunReceiptState({
      intent: { draft: intent, storageAvailable: true },
      context: { draft: videoOnly, storageAvailable: true },
      mediaSession: media(),
      recipes,
      readinessCanRun: true,
      now: "2026-08-22T12:00:00.000Z",
    });
    expect(state.canSubmit).toBe(true);
    expect(state.blockers).toEqual([]);
    expect(state.intent.label).toBe("Requirements");
    expect(state.context.label).toBe("Video-only");
  });

  test("names custom, changed, unavailable, and unreadable intent blockers", () => {
    const common = {
      context: { draft: videoOnly, storageAvailable: true },
      mediaSession: media(),
      readinessCanRun: false,
      now: "2026-08-22T12:00:00.000Z",
    };
    const custom = deriveRunReceiptState({
      ...common,
      intent: {
        draft: {
          recipe: { custom: {
            id: "synthetic-review",
            label: "Synthetic review",
            description: "Synthetic",
            indexInstruction: "Find.",
            interrogationInstruction: "Verify.",
          } },
          model: "gemini-3.7-flash",
        },
        storageAvailable: true,
      },
      recipes,
    });
    expect(custom.intent.blocker?.code).toBe("custom_recipe");
    expect(custom.intent.blocker?.message).toContain("Custom recipes");

    const changed = deriveRunReceiptState({
      ...common,
      intent: { draft: intent, storageAvailable: true },
      recipes: [{ ...recipes[0]!, revision: "changed" }],
    });
    expect(changed.intent.blocker?.code).toBe("recipe_changed");

    const unavailable = deriveRunReceiptState({
      ...common,
      intent: { draft: intent, storageAvailable: true },
      recipes: [],
    });
    expect(unavailable.intent.blocker?.code).toBe("recipe_unavailable");

    const unreadable = deriveRunReceiptState({
      ...common,
      intent: { storageAvailable: true, invalid: true },
      recipes,
    });
    expect(unreadable.intent.blocker?.code).toBe("intent_unreadable");
  });

  test("blocks missing, expired, or uncommitted context instead of downgrading", () => {
    for (const context of [
      { storageAvailable: true },
      {
        storageAvailable: true,
        draft: {
          schemaVersion: 2 as const,
          mode: "enriched" as const,
          context: {
            provider: "bluedot" as const,
            transport: "mcp" as const,
            meetingId: "synthetic-meeting",
          },
          committed: false,
        },
      },
    ]) {
      const state = deriveRunReceiptState({
        intent: { draft: intent, storageAvailable: true },
        context,
        mediaSession: media(),
        recipes,
        readinessCanRun: true,
        now: "2026-08-22T12:00:00.000Z",
      });
      expect(state.canSubmit).toBe(false);
      expect(state.context.blocker?.link).toBe("/context");
      expect(() => buildComposerPayload(state, {
        idempotencyKey: "studio-run-0001",
        retention: { mode: "ephemeral" },
      })).toThrow("Run receipt is blocked");
    }
  });

  test("builds enriched input without changing it to mode none", () => {
    const context = {
      schemaVersion: 2 as const,
      mode: "enriched" as const,
      context: {
        provider: "granola" as const,
        transport: "api" as const,
        meetingId: "not_SYNTHETIC",
      },
      transcriptOffsetSeconds: 90,
      committed: true,
    };
    const state = deriveRunReceiptState({
      intent: { draft: intent, storageAvailable: true },
      context: { draft: context, storageAvailable: true },
      mediaSession: media(),
      recipes,
      readinessCanRun: true,
      now: "2026-08-22T12:00:00.000Z",
    });
    const payload = buildComposerPayload(state, {
      idempotencyKey: "studio-run-0001",
      retention: { mode: "ephemeral" },
    });
    expect(payload.context).toEqual(context.context);
    expect(payload.transcriptOffsetSeconds).toBe(90);
    expect(payload.context).not.toEqual({ mode: "none" });
  });

  test("keeps one reusable idempotency key while recomputing live retention", () => {
    const storage = new MemoryStorage();
    storage.setItem(RUN_DRAFT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: "studio-run-generated-0001",
      retention: { mode: "ephemeral" },
    }));
    const draft = createOrLoadRunDraft(
      storage,
      { mode: "retained", ttlSeconds: 60 * 60 },
      () => "studio-run-generated-0002",
    );
    expect(draft).toEqual({
      idempotencyKey: "studio-run-generated-0001",
      retention: { mode: "retained", ttlSeconds: 60 * 60 },
    });
    expect(JSON.parse(storage.getItem(RUN_DRAFT_STORAGE_KEY)!)).toEqual({
      idempotencyKey: "studio-run-generated-0001",
    });
    expect(clearRunDraft(storage)).toBe(true);
    expect(storage.getItem(RUN_DRAFT_STORAGE_KEY)).toBeNull();
  });

  test("rejects a retained media lifetime below the request floor", () => {
    const retained = media();
    retained.retention = {
      mode: "retained",
      expiresAt: "2026-08-22T11:30:00.000Z",
    };
    expect(() => retentionRequestForMediaSession(retained)).toThrow();
  });

  test("maps changed recording retention back to Recording and Run", () => {
    expect(runFieldErrorForJobCode("media_retention_mismatch")).toEqual({
      section: "recording",
      message: "The recording's retention changed. Reopen Run to refresh the exact receipt.",
    });
  });

  test("maps an idempotency conflict to Home and starts only a fresh Run receipt", () => {
    expect(runFieldErrorForJobCode("idempotency_conflict")).toEqual({
      section: "home",
      message: "A job already exists under this retry key. Open Home, or start a fresh receipt.",
      canStartFreshReceipt: true,
    });

    const storage = new MemoryStorage();
    storage.setItem("frame-of-mind:studio:intent-draft", "intent-receipt");
    storage.setItem("frame-of-mind:studio:context-draft", "context-receipt");
    storage.setItem("frame-of-mind:studio:media-upload", "media-receipt");
    storage.setItem(RUN_DRAFT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: "studio-run-conflicted-0001",
    }));

    const fresh = startFreshRunReceipt(
      storage,
      { mode: "retained", ttlSeconds: 60 * 60 },
      () => "studio-run-fresh-0002",
    );
    expect(fresh.idempotencyKey).toBe("studio-run-fresh-0002");
    expect(JSON.parse(storage.getItem(RUN_DRAFT_STORAGE_KEY)!)).toEqual({
      idempotencyKey: "studio-run-fresh-0002",
    });
    expect(storage.getItem("frame-of-mind:studio:intent-draft")).toBe("intent-receipt");
    expect(storage.getItem("frame-of-mind:studio:context-draft")).toBe("context-receipt");
    expect(storage.getItem("frame-of-mind:studio:media-upload")).toBe("media-receipt");
  });

  test("shows unavailable retention and disables Start after either mount failure", () => {
    const invalidRetained = media();
    invalidRetained.retention = {
      mode: "retained",
      expiresAt: "2026-08-22T11:30:00.000Z",
    };
    expect(() => retentionRequestForMediaSession(invalidRetained)).toThrow();
    expect(runRetentionDisplay(invalidRetained, undefined)).toEqual({
      mode: "unavailable",
      expiresAt: "2026-08-22T11:30:00.000Z",
    });

    const retained = media();
    retained.retention = {
      mode: "retained",
      expiresAt: "2026-08-22T12:00:00.000Z",
    };
    const unavailableStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("storage unavailable"); },
      removeItem: () => undefined,
    };
    const retention = retentionRequestForMediaSession(retained);
    expect(() => createOrLoadRunDraft(unavailableStorage, retention)).toThrow();
    expect(runRetentionDisplay(retained, undefined)).toEqual({
      mode: "unavailable",
      expiresAt: "2026-08-22T12:00:00.000Z",
    });
    expect(canStartRunAnalysis({ canSubmit: true }, undefined)).toBe(false);
  });
});
