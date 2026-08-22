import { describe, expect, test } from "bun:test";
import {
  composerPayloadSchema,
  type ComposerPayload,
  type MediaSession,
} from "../../../src/domain/studio-schemas";
import {
  translateComposerJob,
} from "../server-local/studio-jobs/composer-translate";
import { StudioJobInputUnavailableError } from "../server-local/studio-jobs/analysis-options";

const now = "2026-08-22T12:00:00.000Z";
const sha256 = "a".repeat(64);
const recipeSha256 = "b".repeat(64);

function payload(overrides: Partial<ComposerPayload> = {}): ComposerPayload {
  return composerPayloadSchema.parse({
    idempotencyKey: "studio-run-0001",
    mediaSessionId: "media_01K123456789ABC",
    context: { mode: "none" },
    recipe: { id: "requirements", revision: "builtin-2026-07-27.1" },
    model: "gemini-3.7-flash",
    retention: { mode: "ephemeral" },
    ...overrides,
  });
}

function media(overrides: Partial<MediaSession> = {}): MediaSession {
  return {
    id: "media_01K123456789ABC",
    status: "sealed",
    expectedBytes: 64,
    receivedBytes: 64,
    partSizeBytes: 8 * 1_024 * 1_024,
    parts: [],
    mimeType: "video/mp4",
    sha256,
    retention: {
      mode: "ephemeral",
      expiresAt: "2026-08-22T13:00:00.000Z",
    },
    createdAt: "2026-08-22T11:00:00.000Z",
    updatedAt: "2026-08-22T11:05:00.000Z",
    ...overrides,
  };
}

const resolvedRecipe = {
  recipe: {
    id: "requirements",
    label: "Requirements",
    description: "Find requirements.",
    indexInstruction: "Find requirements.",
    interrogationInstruction: "Verify requirements.",
  },
  custom: false,
  revision: "builtin-2026-07-27.1",
  sha256: recipeSha256,
};

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected translation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(StudioJobInputUnavailableError);
    expect((error as StudioJobInputUnavailableError).code).toBe(code);
  }
}

describe("Studio composer job translation", () => {
  test("translates an explicit video-only receipt into immutable job input", () => {
    expect(translateComposerJob({
      payload: payload({ focus: "Prioritize acceptance criteria." }),
      mediaSession: media(),
      resolvedRecipe,
      now,
    })).toEqual({
      idempotencyKey: "studio-run-0001",
      input: {
        mediaSessionId: "media_01K123456789ABC",
        mediaSha256: sha256,
        context: { mode: "none" },
        recipe: {
          id: "requirements",
          custom: false,
          revision: "builtin-2026-07-27.1",
          sha256: recipeSha256,
        },
        model: "gemini-3.7-flash",
        focus: "Prioritize acceptance criteria.",
        retention: {
          mode: "ephemeral",
          expiresAt: "2026-08-22T13:00:00.000Z",
        },
      },
    });
  });

  test("preserves one committed provider context and transcript offset", () => {
    const request = translateComposerJob({
      payload: payload({
        context: {
          provider: "bluedot",
          transport: "mcp",
          meetingId: "synthetic-meeting",
        },
        transcriptOffsetSeconds: -90,
      }),
      mediaSession: media(),
      resolvedRecipe,
      now,
    });
    expect(request.input.context).toEqual({
      provider: "bluedot",
      transport: "mcp",
      meetingId: "synthetic-meeting",
    });
    expect(request.input.transcriptOffsetSeconds).toBe(-90);
  });

  test("rejects every non-sealed, missing, expired, or digestless media receipt", () => {
    expectCode(() => translateComposerJob({
      payload: payload(), mediaSession: undefined, resolvedRecipe, now,
    }), "media_not_found");
    for (const status of [
      "created", "uploading", "expired", "deleted", "retained", "in_use",
    ] as const) {
      expectCode(() => translateComposerJob({
        payload: payload(), mediaSession: media({ status }), resolvedRecipe, now,
      }), "media_not_usable");
    }
    expectCode(() => translateComposerJob({
      payload: payload(), mediaSession: media({ sha256: undefined }), resolvedRecipe, now,
    }), "media_not_usable");
    expectCode(() => translateComposerJob({
      payload: payload(),
      mediaSession: media({
        retention: { mode: "ephemeral", expiresAt: now },
      }),
      resolvedRecipe,
      now,
    }), "media_retention_expired");
  });

  test("fails closed for custom, missing, changed, or custom-resolved recipes", () => {
    const customPayload = payload({
      recipe: {
        custom: {
          id: "synthetic-review",
          label: "Synthetic review",
          description: "Review a synthetic fixture.",
          indexInstruction: "Find synthetic evidence.",
          interrogationInstruction: "Verify synthetic evidence.",
        },
      },
    });
    expectCode(() => translateComposerJob({
      payload: customPayload, mediaSession: media(), resolvedRecipe, now,
    }), "custom_recipe_staging_unavailable");
    expectCode(() => translateComposerJob({
      payload: payload(), mediaSession: media(), resolvedRecipe: undefined, now,
    }), "recipe_not_found");
    expectCode(() => translateComposerJob({
      payload: payload(), mediaSession: media(),
      resolvedRecipe: { ...resolvedRecipe, revision: "changed" }, now,
    }), "recipe_receipt_mismatch");
    expectCode(() => translateComposerJob({
      payload: payload(), mediaSession: media(),
      resolvedRecipe: { ...resolvedRecipe, custom: true }, now,
    }), "recipe_receipt_mismatch");
  });

  test("binds retained input to the exact server-owned staged lifetime", () => {
    const retained = media({
      retention: {
        mode: "retained",
        expiresAt: "2026-08-23T11:00:00.000Z",
      },
    });
    const request = translateComposerJob({
      payload: payload({
        retention: { mode: "retained", ttlSeconds: 24 * 60 * 60 },
      }),
      mediaSession: retained,
      resolvedRecipe,
      now,
    });
    expect(request.input.retention).toEqual(retained.retention);

    expectCode(() => translateComposerJob({
      payload: payload({
        retention: { mode: "retained", ttlSeconds: 60 * 60 },
      }),
      mediaSession: retained,
      resolvedRecipe,
      now,
    }), "media_retention_mismatch");
    expectCode(() => translateComposerJob({
      payload: payload(), mediaSession: retained, resolvedRecipe, now,
    }), "media_retention_mismatch");
  });

  test("never manufactures video-only context from missing or draft input", () => {
    expect(composerPayloadSchema.safeParse({
      ...payload(),
      context: undefined,
    }).success).toBe(false);
    expect(composerPayloadSchema.safeParse({
      ...payload(),
      context: { mode: "enriched" },
    }).success).toBe(false);
    expect(composerPayloadSchema.safeParse({
      ...payload(),
      transcriptOffsetSeconds: 30,
    }).success).toBe(false);
  });
});
