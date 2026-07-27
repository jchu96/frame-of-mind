import { describe, expect, test } from "bun:test";
import {
  CONTEXT_DRAFT_STORAGE_KEY,
  clearContextDraft,
  createContextStagingTransport,
  loadContextDraft,
  parseTranscriptOffsetInput,
  persistContextDraft,
  previewContextFile,
  validateContextFile,
} from "../server-local/studio-ui/context-composer";

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

describe("Studio Context composer", () => {
  test("validates the five bounded local context formats", () => {
    for (const [name, type, format] of [
      ["context.json", "application/json", "json"],
      ["notes.txt", "text/plain", "text"],
      ["notes.md", "text/markdown", "markdown"],
      ["captions.srt", "application/x-subrip", "srt"],
      ["captions.vtt", "text/vtt", "vtt"],
    ] as const) {
      expect(validateContextFile(new File(["safe"], name, { type })))
        .toEqual({ ok: true, format });
    }

    expect(validateContextFile(
      new File(["safe"], "context.pdf", { type: "application/pdf" }),
    )).toMatchObject({ ok: false, code: "unsupported_extension" });
    expect(validateContextFile(
      new File(["safe"], "context.json", { type: "text/plain" }),
    )).toMatchObject({ ok: false, code: "mime_mismatch" });
    expect(validateContextFile(
      new File([], "empty.txt", { type: "text/plain" }),
    )).toMatchObject({ ok: false, code: "empty_file" });
  });

  test("previews only a bounded prefix and keeps it component-local", async () => {
    const preview = await previewContextFile(
      new File(["0123456789"], "notes.txt", { type: "text/plain" }),
      5,
    );
    expect(preview).toEqual({ text: "01234", truncated: true });
  });

  test("parses explicit signed alignment without inventing a default", () => {
    expect(parseTranscriptOffsetInput("")).toEqual({ ok: true });
    expect(parseTranscriptOffsetInput("01:02:03")).toEqual({
      ok: true,
      seconds: 3_723,
    });
    expect(parseTranscriptOffsetInput("-01:02:03")).toEqual({
      ok: true,
      seconds: -3_723,
    });
    expect(parseTranscriptOffsetInput("1:2:3")).toMatchObject({
      ok: false,
    });
  });

  test("persists only typed context receipts and provider identifiers", () => {
    const storage = new MemoryStorage();
    const draft = {
      schemaVersion: 1 as const,
      mediaSessionId: "media_01K123456789ABC",
      context: {
        provider: "file" as const,
        transport: "file" as const,
        contextFileId: "context_01K123456789ABC",
        contextFileSha256: "c".repeat(64),
      },
      transcriptOffsetSeconds: -3_723,
      committed: true,
    };
    expect(persistContextDraft(storage, draft)).toBe(true);
    expect(loadContextDraft(storage)).toEqual({
      draft,
      storageAvailable: true,
    });
    const serialized = storage.values.get(CONTEXT_DRAFT_STORAGE_KEY)!;
    expect(serialized).not.toContain("filename");
    expect(serialized).not.toContain("private spoken words");
    expect(serialized).not.toContain("/Users/");

    clearContextDraft(storage);
    expect(loadContextDraft(storage)).toEqual({ storageAvailable: true });
  });

  test("stages, verifies, and deletes only opaque context receipts", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const receipt = {
      id: "context_01K123456789ABC",
      format: "markdown",
      bytes: 7,
      sha256: "d".repeat(64),
      expiresAt: "2026-07-27T18:00:00.000Z",
    };
    const transport = createContextStagingTransport(
      async (url, init) => {
        requests.push({ url: String(url), init });
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return Response.json(receipt, {
          status: init?.method === "POST" ? 201 : 200,
        });
      },
    );
    const file = new File(["# Notes"], "notes.md", {
      type: "text/markdown",
    });

    await expect(transport.stage(file, "markdown")).resolves.toEqual(receipt);
    await expect(transport.status(receipt.id)).resolves.toEqual(receipt);
    await expect(transport.delete(receipt.id)).resolves.toBeUndefined();
    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ["/api/context-files", "POST"],
      [`/api/context-files/${receipt.id}`, "GET"],
      [`/api/context-files/${receipt.id}`, "DELETE"],
    ]);
    expect(new Headers(requests[0]!.init?.headers).get("x-context-format"))
      .toBe("markdown");
    expect(requests[0]!.init?.body).toBe(file);
  });
});
