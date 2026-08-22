import { z } from "zod";
import {
  contextFileFormatSchema,
  contextFileReceiptSchema,
  MAX_CONTEXT_FILE_BYTES,
  providerContextSchema,
  transcriptOffsetSecondsSchema,
  type ContextFileFormat,
} from "../../../../src/domain/studio-schemas";
import { opaqueIdSchema } from "../../../../src/domain/studio-identifiers";
import { parseSignedOffset } from "../../../../src/lib/time";

export const CONTEXT_DRAFT_STORAGE_KEY =
  "frame-of-mind:studio:context-draft";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const legacyContextDraftSchema = z.object({
  schemaVersion: z.literal(1),
  mediaSessionId: opaqueIdSchema,
  context: providerContextSchema,
  transcriptOffsetSeconds: transcriptOffsetSecondsSchema.optional(),
  committed: z.boolean(),
}).strict();

const enrichedContextDraftSchema = z.object({
  schemaVersion: z.literal(2),
  mode: z.literal("enriched"),
  context: providerContextSchema,
  transcriptOffsetSeconds: transcriptOffsetSecondsSchema.optional(),
  committed: z.boolean(),
}).strict();

const videoOnlyContextDraftSchema = z.object({
  schemaVersion: z.literal(2),
  mode: z.literal("video-only"),
  committed: z.literal(true),
}).strict();

const contextDraftSchema = z.discriminatedUnion("mode", [
  enrichedContextDraftSchema,
  videoOnlyContextDraftSchema,
]);

export type ContextDraft = z.infer<typeof contextDraftSchema>;
export type EnrichedContextDraft = z.infer<typeof enrichedContextDraftSchema>;
export type ContextFileReceipt = z.infer<typeof contextFileReceiptSchema>;

const descriptorByExtension: Record<string, {
  format: ContextFileFormat;
  mimeType: string;
  compatibleDeclaredTypes: readonly string[];
}> = {
  ".json": {
    format: "json",
    mimeType: "application/json",
    compatibleDeclaredTypes: ["application/json"],
  },
  ".txt": {
    format: "text",
    mimeType: "text/plain",
    compatibleDeclaredTypes: ["text/plain"],
  },
  ".md": {
    format: "markdown",
    mimeType: "text/markdown",
    compatibleDeclaredTypes: ["text/markdown", "text/plain"],
  },
  ".markdown": {
    format: "markdown",
    mimeType: "text/markdown",
    compatibleDeclaredTypes: ["text/markdown", "text/plain"],
  },
  ".srt": {
    format: "srt",
    mimeType: "application/x-subrip",
    compatibleDeclaredTypes: ["application/x-subrip", "text/plain"],
  },
  ".vtt": {
    format: "vtt",
    mimeType: "text/vtt",
    compatibleDeclaredTypes: ["text/vtt"],
  },
};

const mimeTypeByFormat = Object.fromEntries(
  Object.values(descriptorByExtension).map(
    ({ format, mimeType }) => [format, mimeType],
  ),
) as Record<ContextFileFormat, string>;

export type ContextFileValidation =
  | { ok: true; format: ContextFileFormat }
  | { ok: false; code: string; message: string };

export function validateContextFile(
  file: Pick<File, "name" | "size" | "type">,
): ContextFileValidation {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return {
      ok: false,
      code: "empty_file",
      message: "Choose a context file with at least one byte.",
    };
  }
  if (file.size > MAX_CONTEXT_FILE_BYTES) {
    return {
      ok: false,
      code: "file_too_large",
      message: "Choose a context file no larger than 8 MiB.",
    };
  }
  const finalDot = file.name.lastIndexOf(".");
  const extension = finalDot >= 0
    ? file.name.slice(finalDot).toLowerCase()
    : "";
  const descriptor = descriptorByExtension[extension];
  if (!descriptor) {
    return {
      ok: false,
      code: "unsupported_extension",
      message: "Choose JSON, text, Markdown, SRT, or VTT context.",
    };
  }
  const declaredType = file.type
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";
  if (
    declaredType
    && declaredType !== "application/octet-stream"
    && !descriptor.compatibleDeclaredTypes.includes(declaredType)
  ) {
    return {
      ok: false,
      code: "mime_mismatch",
      message: "The context extension and browser-reported type do not agree.",
    };
  }
  return { ok: true, format: descriptor.format };
}

export async function previewContextFile(
  file: Pick<File, "size" | "slice">,
  maximumBytes = 4_096,
): Promise<{ text: string; truncated: boolean }> {
  if (
    !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > 64 * 1_024
  ) {
    throw new Error("Context preview bound is invalid.");
  }
  const prefix = file.slice(0, Math.min(file.size, maximumBytes));
  return {
    text: await prefix.text(),
    truncated: file.size > maximumBytes,
  };
}

export type TranscriptOffsetInput =
  | { ok: true; seconds?: number }
  | { ok: false; message: string };

export function parseTranscriptOffsetInput(
  value: string,
): TranscriptOffsetInput {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  try {
    const seconds = transcriptOffsetSecondsSchema.parse(
      parseSignedOffset(trimmed),
    );
    return { ok: true, seconds };
  } catch {
    return {
      ok: false,
      message: "Use signed HH:MM:SS, for example 01:02:47 or -00:04:30.",
    };
  }
}

export function persistContextDraft(
  storage: BrowserStorage,
  draft: ContextDraft,
): boolean {
  try {
    storage.setItem(
      CONTEXT_DRAFT_STORAGE_KEY,
      JSON.stringify(contextDraftSchema.parse(draft)),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadContextDraft(
  storage: BrowserStorage,
): { draft?: ContextDraft; storageAvailable: boolean } {
  try {
    const raw = storage.getItem(CONTEXT_DRAFT_STORAGE_KEY);
    if (!raw) return { storageAvailable: true };
    const json = JSON.parse(raw);
    const parsed = contextDraftSchema.safeParse(json);
    if (parsed.success) {
      return { draft: parsed.data, storageAvailable: true };
    }
    const legacy = legacyContextDraftSchema.safeParse(json);
    if (!legacy.success) {
      storage.removeItem(CONTEXT_DRAFT_STORAGE_KEY);
      return { storageAvailable: true };
    }
    const migrated: EnrichedContextDraft = {
      schemaVersion: 2,
      mode: "enriched",
      context: legacy.data.context,
      ...(legacy.data.transcriptOffsetSeconds === undefined
        ? {}
        : { transcriptOffsetSeconds: legacy.data.transcriptOffsetSeconds }),
      committed: legacy.data.committed,
    };
    storage.setItem(CONTEXT_DRAFT_STORAGE_KEY, JSON.stringify(migrated));
    return { draft: migrated, storageAvailable: true };
  } catch {
    return { storageAvailable: false };
  }
}

export function clearContextDraft(storage: BrowserStorage): boolean {
  try {
    storage.removeItem(CONTEXT_DRAFT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export class ContextStagingClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ContextStagingClientError";
  }
}

async function readReceipt(response: Response): Promise<ContextFileReceipt> {
  if (!response.ok) {
    throw new ContextStagingClientError(
      `http_${response.status}`,
      response.status === 404
        ? "The staged context expired or was already consumed."
        : "The local Studio could not complete the context request.",
      response.status,
    );
  }
  return contextFileReceiptSchema.parse(await response.json());
}

export interface ContextStagingTransport {
  stage(
    file: File,
    format: ContextFileFormat,
    signal?: AbortSignal,
  ): Promise<ContextFileReceipt>;
  status(id: string, signal?: AbortSignal): Promise<ContextFileReceipt>;
  delete(id: string, signal?: AbortSignal): Promise<void>;
}

export function createContextStagingTransport(
  fetchImplementation: typeof fetch = globalThis.fetch,
): ContextStagingTransport {
  return {
    async stage(file, format, signal) {
      const parsedFormat = contextFileFormatSchema.parse(format);
      return readReceipt(await fetchImplementation("/api/context-files", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": mimeTypeByFormat[parsedFormat],
          "x-context-format": parsedFormat,
        },
        body: file,
        signal,
      }));
    },
    async status(id, signal) {
      const safeId = opaqueIdSchema.parse(id);
      return readReceipt(await fetchImplementation(
        `/api/context-files/${encodeURIComponent(safeId)}`,
        { method: "GET", credentials: "same-origin", signal },
      ));
    },
    async delete(id, signal) {
      const safeId = opaqueIdSchema.parse(id);
      const response = await fetchImplementation(
        `/api/context-files/${encodeURIComponent(safeId)}`,
        {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal,
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new ContextStagingClientError(
          `http_${response.status}`,
          "The local Studio could not delete staged context.",
          response.status,
        );
      }
    },
  };
}
