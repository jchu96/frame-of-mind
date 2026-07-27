import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validateMediaSessionTransition } from "../../../src/domain/studio-state";
import {
  isMediaExpiryCandidate,
  LocalMediaStagingAdapter,
  MediaStagingError,
} from "../server-local/studio-media/local-media-staging";

const initialNow = Date.parse("2026-07-27T08:00:00.000Z");
const mebibyte = 1_024 * 1_024;

function mp4Fixture(bytes: number): Uint8Array {
  const fixture = new Uint8Array(bytes);
  fixture.set(new Uint8Array([0x00, 0x00, 0x00, 0x18]).subarray(0, bytes), 0);
  if (bytes > 4) {
    fixture.set(
      new TextEncoder().encode("ftypisom").subarray(0, bytes - 4),
      4,
    );
  }
  for (let index = 12; index < bytes; index += 1) {
    fixture[index] = index % 251;
  }
  return fixture;
}

function webmFixture(bytes: number): Uint8Array {
  const fixture = new Uint8Array(bytes);
  fixture.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  for (let index = 4; index < bytes; index += 1) {
    fixture[index] = index % 251;
  }
  return fixture;
}

async function* chunks(
  bytes: Uint8Array,
  chunkBytes = 3,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    yield bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength));
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileFingerprint(bytes: Uint8Array, partSizeBytes = 8): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += partSizeBytes) {
    parts.push(digest(bytes.subarray(
      offset,
      Math.min(offset + partSizeBytes, bytes.byteLength),
    )));
  }
  return createHash("sha256").update(parts.join("")).digest("hex");
}

async function expectMediaError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected media staging error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(MediaStagingError);
    expect((error as MediaStagingError).code).toBe(code);
  }
}

describe("local media staging adapter", () => {
  let root: string;
  let now: number;
  let identifiers: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "frame-of-mind-media-test-"));
    now = initialNow;
    identifiers = [
      "media_01K123456789ABC",
      "media_01K123456789DEF",
      "media_01K123456789GHI",
    ];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function adapter(overrides: {
    availableBytes?: () => Promise<number>;
    removeFile?: (path: string) => Promise<void>;
  } = {}) {
    return new LocalMediaStagingAdapter({
      rootDirectory: root,
      partSizeBytes: 8,
      uploadTtlSeconds: 60,
      minimumFreeBytes: 16,
      now: () => new Date(now),
      createId: () => identifiers.shift()!,
      availableBytes: overrides.availableBytes
        ?? (async () => 10 * mebibyte),
      removeFile: overrides.removeFile,
    });
  }

  async function create(
    staging: LocalMediaStagingAdapter,
    input: Partial<{
      idempotencyKey: string;
      expectedBytes: number;
      mimeType: string;
      fileFingerprintSha256: string;
      retention:
        | { mode: "ephemeral" }
        | { mode: "retained"; ttlSeconds: number };
    }> = {},
  ) {
    return staging.create({
      idempotencyKey: "media-create-0001",
      expectedBytes: 20,
      mimeType: "video/mp4",
      retention: { mode: "ephemeral" },
      ...input,
    });
  }

  async function writeFixture(
    staging: LocalMediaStagingAdapter,
    id: string,
    fixture: Uint8Array,
  ) {
    for (let part = 0; part < Math.ceil(fixture.byteLength / 8); part += 1) {
      const offset = part * 8;
      const bytes = fixture.subarray(offset, Math.min(offset + 8, fixture.byteLength));
      await staging.writePart(id, {
        part,
        offset,
        contentLength: bytes.byteLength,
        bytes: chunks(bytes),
      });
    }
  }

  test("creates a private opaque receipt and replays the same create request", async () => {
    const staging = adapter();
    const first = await create(staging);
    const replay = await create(staging);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      id: "media_01K123456789ABC",
      status: "created",
      expectedBytes: 20,
      receivedBytes: 0,
      partSizeBytes: 8,
      parts: [],
      uploadExpiresAt: "2026-07-27T08:01:00.000Z",
      retention: {
        mode: "ephemeral",
        expiresAt: "2026-07-27T08:01:00.000Z",
      },
    });
    expect(JSON.stringify(first)).not.toContain(root);

    const sessionDirectory = join(root, "sessions", first.id);
    expect((await stat(sessionDirectory)).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(sessionDirectory)).mode & 0o777).toBe(0o700);
    }

    await expectMediaError(create(staging, {
      expectedBytes: 21,
    }), "idempotency_conflict");
  });

  test("migrates an existing ephemeral receipt to a server-owned expiry", async () => {
    const staging = adapter();
    const session = await create(staging);
    const receiptPath = join(root, "sessions", session.id, "session.json");
    const stored = JSON.parse(await readFile(receiptPath, "utf8")) as {
      session: { retention: { expiresAt?: string } };
    };
    delete stored.session.retention.expiresAt;
    await writeFile(receiptPath, `${JSON.stringify(stored)}\n`);

    await expect(staging.get(session.id)).resolves.toMatchObject({
      retention: {
        mode: "ephemeral",
        expiresAt: "2026-07-27T08:01:00.000Z",
      },
    });
  });

  test("reserves the complete upload plus a free-space safety margin", async () => {
    const staging = adapter({
      availableBytes: async () => 35,
    });
    await expectMediaError(create(staging), "insufficient_disk");
    expect(await readdir(root)).toEqual(["sessions"]);
  });

  test("rejects out-of-order parts and resumes from durable receipts", async () => {
    const staging = adapter();
    const session = await create(staging);
    const fixture = mp4Fixture(20);

    await expectMediaError(staging.writePart(session.id, {
      part: 1,
      offset: 8,
      contentLength: 8,
      bytes: chunks(fixture.subarray(8, 16)),
    }), "part_out_of_order");

    const first = await staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(fixture.subarray(0, 8)),
    });
    expect(first).toMatchObject({
      replayed: false,
      session: {
        status: "uploading",
        receivedBytes: 8,
        parts: [{ part: 0, offset: 0, bytes: 8 }],
      },
    });

    const resumed = adapter();
    const second = await resumed.writePart(session.id, {
      part: 1,
      offset: 8,
      contentLength: 8,
      bytes: chunks(fixture.subarray(8, 16)),
    });
    expect(second.session.receivedBytes).toBe(16);

    const replay = await resumed.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(fixture.subarray(0, 8)),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.session.receivedBytes).toBe(16);

    const changed = fixture.slice(0, 8);
    changed[7] ^= 0xff;
    await expectMediaError(resumed.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(changed),
    }), "part_conflict");
  });

  test("rejects a concurrent writer for the same session", async () => {
    const staging = adapter();
    const session = await create(staging);
    const fixture = mp4Fixture(8);
    let release!: () => void;
    let started!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    async function* blockedPart() {
      yield fixture.subarray(0, 4);
      started();
      await releasePromise;
      yield fixture.subarray(4);
    }

    const firstWrite = staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: blockedPart(),
    });
    await startedPromise;
    await expectMediaError(staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(fixture),
    }), "concurrent_writer");
    release();
    await firstWrite;
  });

  test("skips an active writer and expires it on the next sweep", async () => {
    const staging = adapter();
    const session = await create(staging);
    const fixture = mp4Fixture(8);
    let release!: () => void;
    let started!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    async function* blockedPart() {
      yield fixture.subarray(0, 4);
      started();
      await releasePromise;
      yield fixture.subarray(4);
    }

    const activeWrite = staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: blockedPart(),
    });
    await startedPromise;
    now += 60_001;

    expect(await staging.expire()).toEqual([]);
    expect(await staging.get(session.id)).toMatchObject({
      status: "created",
      receivedBytes: 0,
    });

    release();
    await activeWrite;
    expect(await staging.get(session.id)).toMatchObject({
      status: "uploading",
      receivedBytes: 8,
    });
    expect(await staging.expire()).toEqual([
      expect.objectContaining({ id: session.id, status: "deleted" }),
    ]);
  });

  test("prefilters non-expired sessions before acquiring ownership", async () => {
    const staging = adapter();
    const session = await create(staging);

    expect(isMediaExpiryCandidate(session, now)).toBe(false);
    now += 60_001;
    expect(isMediaExpiryCandidate(session, now)).toBe(true);
  });

  test("rolls back short, long, and disk-exhausted part writes", async () => {
    const staging = adapter();
    const session = await create(staging);
    const fixture = mp4Fixture(9);

    await expectMediaError(staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(fixture.subarray(0, 7)),
    }), "part_size_mismatch");

    await expectMediaError(staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(fixture),
    }), "part_size_mismatch");

    async function* diskFailure() {
      yield fixture.subarray(0, 4);
      throw Object.assign(new Error("synthetic disk pressure"), {
        code: "ENOSPC",
      });
    }
    await expectMediaError(staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: diskFailure(),
    }), "disk_exhausted");

    expect(await staging.get(session.id)).toMatchObject({
      status: "created",
      receivedBytes: 0,
      parts: [],
    });
  });

  test("streams the final digest, validates MIME, and atomically seals", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const session = await create(staging);
    await writeFixture(staging, session.id, fixture);

    const sealed = await staging.seal(session.id, {
      expectedSha256: digest(fixture),
    });
    expect(sealed).toMatchObject({
      mediaSessionId: session.id,
      sha256: digest(fixture),
      bytes: fixture.byteLength,
      mimeType: "video/mp4",
      sealedAt: "2026-07-27T08:00:00.000Z",
    });
    const sealedSession = await staging.get(session.id);
    expect(sealedSession).toMatchObject({
      status: "sealed",
      sha256: digest(fixture),
    });
    expect(sealedSession).not.toHaveProperty("uploadExpiresAt");

    const paths = await readdir(join(root, "sessions", session.id));
    expect(paths).toContain("media.sealed");
    expect(paths).not.toContain("media.partial");
  });

  test("keeps an upload resumable after digest or detected-MIME mismatch", async () => {
    const fixture = mp4Fixture(20);
    const staging = adapter();
    const session = await create(staging);
    await writeFixture(staging, session.id, fixture);

    await expectMediaError(staging.seal(session.id, {
      expectedSha256: "b".repeat(64),
    }), "digest_mismatch");
    expect(await staging.get(session.id)).toMatchObject({
      status: "uploading",
      receivedBytes: 20,
    });

    const webmSession = await create(staging, {
      idempotencyKey: "media-create-0002",
      mimeType: "video/webm",
    });
    await writeFixture(staging, webmSession.id, fixture);
    await expectMediaError(staging.seal(webmSession.id), "mime_mismatch");
    expect(await staging.get(webmSession.id)).toMatchObject({
      status: "uploading",
    });
  });

  test("binds all uploaded parts to the file fingerprint from creation", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const changed = fixture.slice();
    changed[19] ^= 0xff;
    const session = await create(staging, {
      fileFingerprintSha256: fileFingerprint(fixture),
    });
    await writeFixture(staging, session.id, changed);

    await expectMediaError(
      staging.seal(session.id),
      "file_fingerprint_mismatch",
    );
    expect(await staging.get(session.id)).toMatchObject({
      status: "uploading",
      fileFingerprintSha256: fileFingerprint(fixture),
    });
  });

  test("accepts WebM magic and supports digest-verified reattachment", async () => {
    const fixture = webmFixture(20);
    const staging = adapter();
    const original = await create(staging, {
      mimeType: "video/webm",
    });
    await writeFixture(staging, original.id, fixture);
    await staging.seal(original.id, { expectedSha256: digest(fixture) });
    await staging.delete(original.id);

    const reattached = await create(staging, {
      idempotencyKey: "media-reattach-0001",
      mimeType: "video/webm",
    });
    await writeFixture(staging, reattached.id, fixture);
    await expectMediaError(staging.seal(reattached.id, {
      expectedSha256: "c".repeat(64),
    }), "digest_mismatch");
    await expect(staging.seal(reattached.id, {
      expectedSha256: digest(fixture),
    })).resolves.toMatchObject({
      sha256: digest(fixture),
    });
  });

  test("resolves retained expiry on the server and expires retained media", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const session = await create(staging, {
      retention: { mode: "retained", ttlSeconds: 3_600 },
    });
    expect(session.retention).toEqual({
      mode: "retained",
      expiresAt: "2026-07-27T09:00:00.000Z",
    });
    await writeFixture(staging, session.id, fixture);
    await staging.seal(session.id);
    await staging.transition(validateMediaSessionTransition({
      id: session.id,
      expected: "sealed",
      next: "in_use",
    }));
    await staging.transition(validateMediaSessionTransition({
      id: session.id,
      expected: "in_use",
      next: "retained",
    }));

    now += 3_600_001;
    const expired = await staging.expire();
    expect(expired).toEqual([
      expect.objectContaining({ id: session.id, status: "deleted" }),
    ]);
    expect(await staging.get(session.id)).toMatchObject({
      status: "deleted",
    });
  });

  test("repairs an abandoned retained execution lease on startup", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const session = await create(staging, {
      retention: { mode: "retained", ttlSeconds: 3_600 },
    });
    await writeFixture(staging, session.id, fixture);
    await staging.seal(session.id);
    await staging.transition(validateMediaSessionTransition({
      id: session.id,
      expected: "sealed",
      next: "in_use",
    }));

    await expect(staging.reconcile()).resolves.toMatchObject({
      repaired: [session.id],
      deleted: [],
      failed: [],
    });
    expect(await staging.get(session.id)).toMatchObject({
      status: "retained",
    });
  });

  test("deletes an abandoned ephemeral execution lease on startup", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const session = await create(staging);
    await writeFixture(staging, session.id, fixture);
    await staging.seal(session.id);
    await staging.transition(validateMediaSessionTransition({
      id: session.id,
      expected: "sealed",
      next: "in_use",
    }));

    await expect(staging.reconcile()).resolves.toMatchObject({
      repaired: [],
      deleted: [session.id],
      failed: [],
    });
    expect(await staging.get(session.id)).toMatchObject({
      status: "deleted",
    });
  });

  test("expires sealed ephemeral media without relying on a browser receipt", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const session = await create(staging);
    expect(session.retention).toEqual({
      mode: "ephemeral",
      expiresAt: "2026-07-27T08:01:00.000Z",
    });
    await writeFixture(staging, session.id, fixture);
    await staging.seal(session.id);

    now += 60_001;
    await expect(staging.expire()).resolves.toEqual([
      expect.objectContaining({ id: session.id, status: "deleted" }),
    ]);
  });

  test("rejects deletion while a seal writer owns the session", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const session = await create(staging);
    await writeFixture(staging, session.id, fixture);

    const sealing = staging.seal(session.id);
    await expectMediaError(staging.abort(session.id), "concurrent_writer");
    await expect(sealing).resolves.toMatchObject({
      mediaSessionId: session.id,
    });
  });

  test("aborts idempotently, removes only staged bytes, and preserves a tombstone", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const sourceCopy = fixture.slice();
    const session = await create(staging);
    await staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(fixture.subarray(0, 8)),
    });

    expect(await staging.abort(session.id)).toMatchObject({
      id: session.id,
      status: "deleted",
    });
    expect(await staging.abort(session.id)).toMatchObject({
      id: session.id,
      status: "deleted",
    });
    expect(fixture).toEqual(sourceCopy);
    expect(await readdir(join(root, "sessions", session.id))).toEqual([
      "session.json",
    ]);
  });

  test("retries a cleanup failure without claiming deletion", async () => {
    let shouldFail = true;
    const staging = adapter({
      removeFile: async (path) => {
        if (shouldFail && path.endsWith("media.partial")) {
          shouldFail = false;
          throw Object.assign(new Error("synthetic permission failure"), {
            code: "EACCES",
          });
        }
        await rm(path, { force: true });
      },
    });
    const session = await create(staging);
    await staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(mp4Fixture(8)),
    });

    await expectMediaError(staging.abort(session.id), "cleanup_failed");
    expect(await staging.get(session.id)).toMatchObject({
      status: "cleanup_failed",
      cleanupFailureCode: "eacces",
    });

    const deleted = await staging.abort(session.id);
    expect(deleted).toMatchObject({ status: "deleted" });
    expect(deleted.cleanupFailureCode).toBeUndefined();
  });

  test("retries an expiry cleanup failure on the next sweep", async () => {
    let shouldFail = true;
    const staging = adapter({
      removeFile: async (path) => {
        if (shouldFail && path.endsWith("media.partial")) {
          shouldFail = false;
          throw Object.assign(new Error("synthetic permission failure"), {
            code: "EACCES",
          });
        }
        await rm(path, { force: true });
      },
    });
    const session = await create(staging);
    await staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(mp4Fixture(8)),
    });
    now += 60_001;

    expect(await staging.expire()).toEqual([
      expect.objectContaining({
        id: session.id,
        status: "cleanup_failed",
        cleanupFailureCode: "eacces",
      }),
    ]);
    expect(await staging.expire()).toEqual([
      expect.objectContaining({ id: session.id, status: "deleted" }),
    ]);
  });

  test("expires abandoned uploads and reconciles uncommitted partial bytes", async () => {
    const staging = adapter();
    const session = await create(staging);
    await staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(mp4Fixture(8)),
    });

    const sessionDirectory = join(root, "sessions", session.id);
    const partialPath = join(sessionDirectory, "media.partial");
    await appendFile(partialPath, new Uint8Array([1, 2, 3, 4]));
    expect((await lstat(partialPath)).size).toBe(12);

    const restarted = adapter();
    const report = await restarted.reconcile();
    expect(report).toMatchObject({
      repaired: [session.id],
      failed: [],
    });
    expect((await lstat(partialPath)).size).toBe(8);

    now += 60_001;
    expect(await restarted.expire()).toEqual([
      expect.objectContaining({ id: session.id, status: "deleted" }),
    ]);
  });

  test("enforces upload expiry before accepting more bytes", async () => {
    const staging = adapter();
    const session = await create(staging);
    now += 60_001;

    await expectMediaError(staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(mp4Fixture(8)),
    }), "media_expired");
    expect(await staging.get(session.id)).toMatchObject({
      status: "deleted",
      receivedBytes: 0,
    });
  });

  test("fails closed when restart sees both partial and sealed media", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const session = await create(staging);
    await writeFixture(staging, session.id, fixture);
    const directory = join(root, "sessions", session.id);
    await Bun.write(join(directory, "media.sealed"), fixture);

    const report = await adapter().reconcile();
    expect(report.failed).toEqual([session.id]);
    expect(await staging.get(session.id)).toMatchObject({ status: "failed" });
    expect((await lstat(join(directory, "media.partial"))).size).toBe(20);
    expect((await lstat(join(directory, "media.sealed"))).size).toBe(20);
  });

  test("resolves a private path only for an exact active execution lease", async () => {
    const staging = adapter();
    const fixture = mp4Fixture(20);
    const session = await create(staging);
    await writeFixture(staging, session.id, fixture);
    const sealed = await staging.seal(session.id, {
      expectedSha256: digest(fixture),
    });

    await expectMediaError(
      staging.resolveInUsePath(session.id, sealed.sha256),
      "media_path_unavailable",
    );
    await staging.transition(validateMediaSessionTransition({
      id: session.id,
      expected: "sealed",
      next: "in_use",
    }));
    const path = await staging.resolveInUsePath(
      session.id,
      sealed.sha256,
    );
    expect(path).toBe(await realpath(
      join(root, "sessions", session.id, "media.sealed"),
    ));
    expect(new Uint8Array(await readFile(path))).toEqual(fixture);
    await expectMediaError(
      staging.resolveInUsePath(session.id, "f".repeat(64)),
      "media_path_unavailable",
    );
    const mutated = fixture.slice();
    mutated[mutated.byteLength - 1] ^= 0xff;
    await writeFile(path, mutated);
    await expectMediaError(
      staging.resolveInUsePath(session.id, sealed.sha256),
      "media_digest_mismatch",
    );
    await expectMediaError(staging.abort(session.id), "media_in_use");
    await expect(
      staging.deleteEphemeralExecutionLease(session.id, sealed.sha256),
    ).resolves.toMatchObject({ status: "deleted" });
  });

  test("rejects unknown, traversal-shaped, and symlink-replaced resources", async () => {
    const staging = adapter();
    await expectMediaError(staging.get("../../private"), "invalid_media_id");
    expect(await staging.get("media_01K999999999XYZ")).toBeUndefined();

    const session = await create(staging);
    const sessionDirectory = join(root, "sessions", session.id);
    const partialPath = join(sessionDirectory, "media.partial");
    await Bun.write(partialPath, mp4Fixture(8));
    const replacement = join(root, "replacement");
    await Bun.write(replacement, mp4Fixture(8));
    await rm(partialPath);
    try {
      await import("node:fs/promises").then(({ symlink }) =>
        symlink(replacement, partialPath)
      );
    } catch (error) {
      if (process.platform === "win32") return;
      throw error;
    }

    await expectMediaError(staging.writePart(session.id, {
      part: 0,
      offset: 0,
      contentLength: 8,
      bytes: chunks(mp4Fixture(8)),
    }), "unsafe_staging_file");
  });

  test("rejects linked roots and receipt replacement", async () => {
    if (process.platform === "win32") return;
    const { symlink } = await import("node:fs/promises");
    const checkout = await mkdtemp(join(tmpdir(), "frame-of-mind-checkout-"));
    const checkoutTarget = join(checkout, "private-media");
    const linkedRoot = join(root, "linked-root");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(checkoutTarget, { recursive: true })
    );
    await symlink(checkoutTarget, linkedRoot);
    try {
      const linked = new LocalMediaStagingAdapter({
        rootDirectory: linkedRoot,
        checkoutRoot: checkout,
        partSizeBytes: 8,
        minimumFreeBytes: 0,
        availableBytes: async () => mebibyte,
      });
      await expectMediaError(linked.create({
        idempotencyKey: "linked-root-create",
        expectedBytes: 20,
        mimeType: "video/mp4",
        retention: { mode: "ephemeral" },
      }), "unsafe_staging_root");
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }

    const staging = adapter();
    const session = await create(staging);
    const directory = join(root, "sessions", session.id);
    const receiptPath = join(directory, "session.json");
    const replacement = join(root, "replacement-session.json");
    await Bun.write(replacement, await Bun.file(receiptPath).text());
    await rm(receiptPath);
    await symlink(replacement, receiptPath);
    await expectMediaError(staging.get(session.id), "unsafe_staging_file");
  });
});
