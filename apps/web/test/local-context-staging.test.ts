import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { MAX_CONTEXT_FILE_BYTES } from "../../../src/domain/studio-schemas";
import { FileContextSource } from "../../../src/adapters/file-context";
import {
  ContextFileStagingError,
  LocalContextFileStagingAdapter,
} from "../server-local/studio-context/local-context-staging";

const encoder = new TextEncoder();

function chunks(value: string, splitAt = 3): AsyncIterable<Uint8Array> {
  const bytes = encoder.encode(value);
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes.subarray(0, Math.min(splitAt, bytes.byteLength));
      yield bytes.subarray(Math.min(splitAt, bytes.byteLength));
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "frame-of-mind-context-test-"));
  const checkout = join(root, "checkout");
  const staging = join(root, "private-staging");
  await mkdir(checkout);
  let sequence = 0;
  const adapter = new LocalContextFileStagingAdapter({
    rootDirectory: staging,
    checkoutRoot: checkout,
    createId: () => `context_01K123456789ABC${sequence += 1}`,
    now: () => new Date("2026-07-27T12:00:00.000Z"),
  });
  return {
    adapter,
    root,
    staging,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof ContextFileStagingError ? error.code : undefined;
}

async function expectCode(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(codeOf(error)).toBe(expectedCode);
    return;
  }
  throw new Error(`Expected ${expectedCode} failure.`);
}

describe("local context-file staging", () => {
  test.each([
    ["json", JSON.stringify({ title: "Synthetic", transcript: "Synthetic" })],
    ["text", "Synthetic notes"],
    ["markdown", "# Synthetic notes"],
    ["srt", "1\n00:00:01,000 --> 00:00:02,000\nSynthetic cue\n"],
    ["vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSynthetic cue\n"],
  ] as const)("stages, verifies, and deletes %s context", async (format, body) => {
    const context = await fixture();
    try {
      const expected = encoder.encode(body);
      const receipt = await context.adapter.stage({
        format,
        expectedBytes: expected.byteLength,
        bytes: chunks(body),
      });

      expect(receipt).toEqual({
        id: "context_01K123456789ABC1",
        format,
        bytes: expected.byteLength,
        sha256: createHash("sha256").update(expected).digest("hex"),
        expiresAt: "2026-07-27T13:00:00.000Z",
      });
      expect(await context.adapter.get(receipt.id)).toEqual(receipt);

      const privatePath = await context.adapter.resolvePath(receipt.id);
      const normalized = await new FileContextSource(privatePath)
        .meeting(receipt.id);
      expect(normalized.provider).toBe("file");
      expect(normalized.transcript).toContain("Synthetic");

      await context.adapter.delete(receipt.id);
      await context.adapter.delete(receipt.id);
      expect(await context.adapter.get(receipt.id)).toBeUndefined();
    } finally {
      await context.cleanup();
    }
  });

  test("rejects invalid bounds, malformed content, and interrupted streams", async () => {
    const context = await fixture();
    try {
      await expectCode(context.adapter.stage({
        format: "text",
        expectedBytes: MAX_CONTEXT_FILE_BYTES + 1,
        bytes: chunks("too large"),
      }), "context_too_large");

      await expectCode(context.adapter.stage({
        format: "json",
        expectedBytes: 7,
        bytes: chunks("{broken"),
      }), "invalid_context_content");

      await expectCode(context.adapter.stage({
        format: "text",
        expectedBytes: 8,
        bytes: chunks("short"),
      }), "context_byte_count_mismatch");

      const controller = new AbortController();
      controller.abort();
      await expectCode(context.adapter.stage({
        format: "text",
        expectedBytes: 4,
        bytes: chunks("text"),
      }, { signal: controller.signal }), "aborted");
    } finally {
      await context.cleanup();
    }
  });

  test("expires abandoned context and removes its private bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "frame-of-mind-context-expiry-"));
    const checkout = join(root, "checkout");
    await mkdir(checkout);
    let now = new Date("2026-07-27T12:00:00.000Z");
    const adapter = new LocalContextFileStagingAdapter({
      rootDirectory: join(root, "staging"),
      checkoutRoot: checkout,
      createId: () => "context_01K123456789EXPIRED",
      now: () => now,
      ttlSeconds: 60,
    });
    try {
      const receipt = await adapter.stage({
        format: "text",
        expectedBytes: 4,
        bytes: chunks("text"),
      });
      const path = await adapter.resolvePath(receipt.id);
      now = new Date("2026-07-27T12:01:00.000Z");

      expect(await adapter.expire()).toEqual([receipt.id]);
      expect(await adapter.get(receipt.id)).toBeUndefined();
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("holds an execution lease against deletion and consumes it once", async () => {
    const context = await fixture();
    try {
      const receipt = await context.adapter.stage({
        format: "text",
        expectedBytes: 4,
        bytes: chunks("safe"),
      });
      const lease = await context.adapter.acquire(receipt.id);

      await expectCode(
        context.adapter.delete(receipt.id),
        "context_in_use",
      );
      expect(await readFile(lease.path, "utf8")).toBe("safe");
      await lease.release();
      await lease.release();
      expect(await context.adapter.get(receipt.id)).toBeUndefined();
    } finally {
      await context.cleanup();
    }
  });

  test("does not sweep a context request while its stream is active", async () => {
    const context = await fixture();
    let continueStream = () => {};
    let streamPaused = () => {};
    const paused = new Promise<void>((resolve) => {
      streamPaused = resolve;
    });
    const continuation = new Promise<void>((resolve) => {
      continueStream = resolve;
    });
    const bytes: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode("safe");
        streamPaused();
        await continuation;
        yield encoder.encode("text");
      },
    };
    try {
      const staging = context.adapter.stage({
        format: "text",
        expectedBytes: 8,
        bytes,
      });
      await paused;
      expect(await context.adapter.expire()).toEqual([]);
      continueStream();
      const receipt = await staging;
      expect(await readFile(
        await context.adapter.resolvePath(receipt.id),
        "utf8",
      )).toBe("safetext");
    } finally {
      continueStream();
      await context.cleanup();
    }
  });

  test("continues expiry cleanup after an unrelated corrupt receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "frame-of-mind-context-corrupt-"));
    const checkout = join(root, "checkout");
    await mkdir(checkout);
    let now = new Date("2026-07-27T12:00:00.000Z");
    let sequence = 0;
    const stagingRoot = join(root, "staging");
    const adapter = new LocalContextFileStagingAdapter({
      rootDirectory: stagingRoot,
      checkoutRoot: checkout,
      ttlSeconds: 60,
      now: () => now,
      createId: () => `context_01K123456789BAD${sequence += 1}`,
    });
    try {
      const corrupt = await adapter.stage({
        format: "text",
        expectedBytes: 4,
        bytes: chunks("safe"),
      });
      const expired = await adapter.stage({
        format: "text",
        expectedBytes: 4,
        bytes: chunks("text"),
      });
      const expiredPath = await adapter.resolvePath(expired.id);
      await writeFile(
        join(stagingRoot, "files", corrupt.id, "receipt.json"),
        "{broken",
        "utf8",
      );
      now = new Date("2026-07-27T12:01:00.000Z");

      await expectCode(adapter.expire(), "corrupt_context_receipt");
      await expect(lstat(expiredPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when staged bytes or file identity are replaced", async () => {
    const context = await fixture();
    try {
      const receipt = await context.adapter.stage({
        format: "text",
        expectedBytes: 4,
        bytes: chunks("safe"),
      });
      const path = await context.adapter.resolvePath(receipt.id);
      await writeFile(path, "evil", "utf8");
      await expectCode(
        context.adapter.get(receipt.id),
        "context_digest_mismatch",
      );

      await rm(path, { force: true });
      await writeFile(join(context.root, "outside.txt"), "safe", "utf8");
      await symlink(join(context.root, "outside.txt"), path);
      await expectCode(
        context.adapter.get(receipt.id),
        "unsafe_context_file",
      );
    } finally {
      await context.cleanup();
    }
  });

  test("rejects a staging root inside or symlinked into the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "frame-of-mind-context-root-"));
    const checkout = join(root, "checkout");
    await mkdir(checkout);
    try {
      expect(() => new LocalContextFileStagingAdapter({
        rootDirectory: join(checkout, "staging"),
        checkoutRoot: checkout,
      })).toThrow(/outside the source checkout/i);

      const link = join(root, "linked-staging");
      await symlink(join(checkout, "hidden"), link);
      const adapter = new LocalContextFileStagingAdapter({
        rootDirectory: link,
        checkoutRoot: checkout,
      });
      await expectCode(adapter.stage({
        format: "text",
        expectedBytes: 4,
        bytes: chunks("safe"),
      }), "unsafe_staging_root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stores no private path or body in the public receipt", async () => {
    const context = await fixture();
    try {
      const receipt = await context.adapter.stage({
        format: "markdown",
        expectedBytes: 16,
        bytes: chunks("private body 123"),
      });
      const receiptPath = join(
        context.staging,
        "files",
        receipt.id,
        "receipt.json",
      );
      const serialized = await readFile(receiptPath, "utf8");
      expect(serialized).not.toContain(context.staging);
      expect(serialized).not.toContain("private body");
      expect(dirname(await context.adapter.resolvePath(receipt.id)))
        .toBe(dirname(receiptPath));
    } finally {
      await context.cleanup();
    }
  });
});
