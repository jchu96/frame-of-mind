import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  rm,
  statfs,
  truncate,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, join, sep } from "node:path";
import { z } from "zod";
import type {
  BinaryChunkSource,
  MediaPartInput,
  MediaPartWriteResult,
  MediaSealReceipt,
  MediaSessionCreateInput,
  MediaStagingAdapter,
} from "../../../../src/domain/studio-ports";
import {
  DEFAULT_MEDIA_PART_SIZE_BYTES,
  MAX_MEDIA_PARTS,
  MAX_RETAINED_MEDIA_TTL_SECONDS,
  mediaCreateRequestSchema,
  mediaSessionSchema,
  sha256Schema,
  type MediaSession,
} from "../../../../src/domain/studio-schemas";
import {
  parseOpaqueResourceId,
  type OpaqueResourceId,
} from "../../../../src/domain/studio-identifiers";
import {
  assertMediaSessionTransition,
  type ValidatedMediaTransition,
} from "../../../../src/domain/studio-state";

const storedMediaSessionSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyDigest: sha256Schema,
  requestDigest: sha256Schema,
  session: mediaSessionSchema,
}).strict();

type StoredMediaSession = z.infer<typeof storedMediaSessionSchema>;

export { DEFAULT_MEDIA_PART_SIZE_BYTES };
const DEFAULT_UPLOAD_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MINIMUM_FREE_BYTES = 512 * 1_024 * 1_024;
const FILE_SINK_HIGH_WATER_MARK = 256 * 1_024;

export class MediaStagingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaStagingError";
  }
}

export interface LocalMediaStagingOptions {
  rootDirectory: string;
  checkoutRoot?: string;
  partSizeBytes?: number;
  uploadTtlSeconds?: number;
  minimumFreeBytes?: number;
  now?: () => Date;
  createId?: () => string;
  availableBytes?: () => Promise<number>;
  removeFile?: (path: string) => Promise<void>;
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function migrateEphemeralExpiry(
  value: unknown,
  uploadTtlSeconds: number,
): unknown {
  if (!value || typeof value !== "object") return value;
  const stored = value as Record<string, unknown>;
  if (!stored.session || typeof stored.session !== "object") return value;
  const session = stored.session as Record<string, unknown>;
  if (!session.retention || typeof session.retention !== "object") return value;
  const retention = session.retention as Record<string, unknown>;
  if (retention.mode !== "ephemeral" || retention.expiresAt !== undefined) {
    return value;
  }
  const expiresAt = typeof session.uploadExpiresAt === "string"
    ? session.uploadExpiresAt
    : new Date(
        Date.parse(String(session.createdAt))
          + uploadTtlSeconds * 1_000,
      ).toISOString();
  return {
    ...stored,
    session: {
      ...session,
      retention: { ...retention, expiresAt },
    },
  };
}

function errorCode(error: unknown): string {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z0-9_]+$/.test(error.code)
  ) {
    return error.code.toLowerCase();
  }
  return "unknown";
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MediaStagingError("aborted", "Media staging was aborted.");
  }
}

export function isMediaExpiryCandidate(
  session: MediaSession,
  now: number,
): boolean {
  const uploadExpired = ["created", "uploading"].includes(session.status)
    && session.uploadExpiresAt !== undefined
    && Date.parse(session.uploadExpiresAt) <= now;
  const retentionExpired = ["sealed", "retained"].includes(session.status)
    && Date.parse(session.retention.expiresAt) <= now;
  const cleanupPending = ["expired", "deleting", "cleanup_failed"]
    .includes(session.status);
  return uploadExpired || retentionExpired || cleanupPending;
}

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "enoent") return undefined;
    throw error;
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  if (process.platform === "win32") return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularFile(
  value: Awaited<ReturnType<typeof lstat>>,
): void {
  if (value.isSymbolicLink() || !value.isFile()) {
    throw new MediaStagingError(
      "unsafe_staging_file",
      "Media staging encountered an unsafe filesystem replacement.",
    );
  }
}

function assertPrivateDirectory(
  value: Awaited<ReturnType<typeof lstat>>,
): void {
  if (value.isSymbolicLink() || !value.isDirectory()) {
    throw new MediaStagingError(
      "unsafe_staging_file",
      "Media staging encountered an unsafe directory replacement.",
    );
  }
}

function detectedMimeType(prefix: Uint8Array): string | undefined {
  if (
    prefix.byteLength >= 4
    && prefix[0] === 0x1a
    && prefix[1] === 0x45
    && prefix[2] === 0xdf
    && prefix[3] === 0xa3
  ) {
    return "video/webm";
  }
  if (
    prefix.byteLength >= 12
    && new TextDecoder().decode(prefix.subarray(4, 8)) === "ftyp"
  ) {
    return new TextDecoder().decode(prefix.subarray(8, 12)) === "qt  "
      ? "video/quicktime"
      : "video/mp4";
  }
  return undefined;
}

export class LocalMediaStagingAdapter implements MediaStagingAdapter {
  readonly #rootDirectory: string;
  readonly #sessionsDirectory: string;
  readonly #checkoutRoot: string;
  readonly #partSizeBytes: number;
  readonly #uploadTtlSeconds: number;
  readonly #minimumFreeBytes: number;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #availableBytes: () => Promise<number>;
  readonly #removeFile: (path: string) => Promise<void>;
  readonly #activeWriters = new Set<string>();
  #creationTail = Promise.resolve();

  constructor(options: LocalMediaStagingOptions) {
    const rootDirectory = resolve(options.rootDirectory);
    const checkoutRoot = resolve(options.checkoutRoot ?? process.cwd());
    const checkoutRelative = relative(checkoutRoot, rootDirectory);
    if (
      !checkoutRelative
      || (
        checkoutRelative !== ".."
        && !checkoutRelative.startsWith(`..${sep}`)
        && !isAbsolute(checkoutRelative)
      )
    ) {
      throw new MediaStagingError(
        "unsafe_staging_root",
        "Media staging must live outside the source checkout.",
      );
    }
    const partSizeBytes = options.partSizeBytes
      ?? DEFAULT_MEDIA_PART_SIZE_BYTES;
    if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0) {
      throw new MediaStagingError(
        "invalid_part_size",
        "Media part size must be a positive safe integer.",
      );
    }
    const uploadTtlSeconds = options.uploadTtlSeconds
      ?? DEFAULT_UPLOAD_TTL_SECONDS;
    if (
      !Number.isSafeInteger(uploadTtlSeconds)
      || uploadTtlSeconds <= 0
      || uploadTtlSeconds > MAX_RETAINED_MEDIA_TTL_SECONDS
    ) {
      throw new MediaStagingError(
        "invalid_upload_ttl",
        "Media upload TTL must be between one second and seven days.",
      );
    }

    this.#rootDirectory = rootDirectory;
    this.#sessionsDirectory = join(rootDirectory, "sessions");
    this.#checkoutRoot = checkoutRoot;
    this.#partSizeBytes = partSizeBytes;
    this.#uploadTtlSeconds = uploadTtlSeconds;
    this.#minimumFreeBytes = options.minimumFreeBytes
      ?? DEFAULT_MINIMUM_FREE_BYTES;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId
      ?? (() => `media_${randomBytes(18).toString("base64url")}`);
    this.#availableBytes = options.availableBytes ?? (async () => {
      const filesystem = await statfs(this.#rootDirectory, { bigint: true });
      const available = filesystem.bavail * filesystem.bsize;
      return available > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(available);
    });
    this.#removeFile = options.removeFile
      ?? ((path) => rm(path, { force: true }));
  }

  async #ensureRoot(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.#rootDirectory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new MediaStagingError(
        "unsafe_staging_root",
        "Media staging root must be a private directory, not a link.",
      );
    }
    const canonicalRoot = await realpath(this.#rootDirectory);
    const canonicalCheckout = await realpath(this.#checkoutRoot);
    const checkoutRelative = relative(canonicalCheckout, canonicalRoot);
    if (
      !checkoutRelative
      || (
        checkoutRelative !== ".."
        && !checkoutRelative.startsWith(`..${sep}`)
        && !isAbsolute(checkoutRelative)
      )
    ) {
      throw new MediaStagingError(
        "unsafe_staging_root",
        "Media staging must resolve outside the source checkout.",
      );
    }
    await mkdir(this.#sessionsDirectory, { recursive: true, mode: 0o700 });
    const sessionsStat = await lstat(this.#sessionsDirectory);
    if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
      throw new MediaStagingError(
        "unsafe_staging_root",
        "Media sessions root must be a private directory, not a link.",
      );
    }
    if (process.platform !== "win32") {
      await chmod(this.#rootDirectory, 0o700);
      await chmod(this.#sessionsDirectory, 0o700);
    }
  }

  #parseId(value: string): OpaqueResourceId {
    try {
      return parseOpaqueResourceId(value);
    } catch {
      throw new MediaStagingError(
        "invalid_media_id",
        "Media session identifier is invalid.",
      );
    }
  }

  #sessionDirectory(id: OpaqueResourceId): string {
    return join(this.#sessionsDirectory, id);
  }

  #receiptPath(id: OpaqueResourceId): string {
    return join(this.#sessionDirectory(id), "session.json");
  }

  #partialPath(id: OpaqueResourceId): string {
    return join(this.#sessionDirectory(id), "media.partial");
  }

  #sealedPath(id: OpaqueResourceId): string {
    return join(this.#sessionDirectory(id), "media.sealed");
  }

  async #readStored(id: OpaqueResourceId): Promise<StoredMediaSession | undefined> {
    const directoryStat = await optionalStat(this.#sessionDirectory(id));
    if (!directoryStat) return undefined;
    assertPrivateDirectory(directoryStat);
    const path = this.#receiptPath(id);
    const receiptStat = await optionalStat(path);
    if (!receiptStat) return undefined;
    assertRegularFile(receiptStat);
    let handle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(receiptStat, opened)) {
        throw new MediaStagingError(
          "unsafe_staging_file",
          "Media receipt identity changed while it was opened.",
        );
      }
      return storedMediaSessionSchema.parse(migrateEphemeralExpiry(
        JSON.parse(await handle.readFile("utf8")),
        this.#uploadTtlSeconds,
      ));
    } catch (error) {
      if (error instanceof MediaStagingError) throw error;
      throw new MediaStagingError(
        "corrupt_media_receipt",
        "Media session receipt is invalid.",
      );
    } finally {
      await handle?.close();
    }
  }

  async #requireStored(id: OpaqueResourceId): Promise<StoredMediaSession> {
    const stored = await this.#readStored(id);
    if (!stored) {
      throw new MediaStagingError(
        "media_not_found",
        "Media session was not found.",
      );
    }
    return stored;
  }

  async #writeStored(stored: StoredMediaSession): Promise<void> {
    const parsed = storedMediaSessionSchema.parse(stored);
    const directory = this.#sessionDirectory(parsed.session.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(await lstat(directory));
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const temporary = join(
      directory,
      `.session-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(parsed)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, this.#receiptPath(parsed.session.id));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #storedSessions(): Promise<StoredMediaSession[]> {
    await this.#ensureRoot();
    const stored: StoredMediaSession[] = [];
    for (
      const entry of await readdir(this.#sessionsDirectory, {
        withFileTypes: true,
      })
    ) {
      if (!entry.isDirectory()) continue;
      let id: OpaqueResourceId;
      try {
        id = this.#parseId(entry.name);
      } catch {
        continue;
      }
      const receipt = await this.#readStored(id);
      if (receipt) stored.push(receipt);
    }
    return stored;
  }

  async #withCreationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#creationTail;
    let release!: () => void;
    this.#creationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async create(
    input: MediaSessionCreateInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<MediaSession> {
    return this.#withCreationLock(async () => {
      abortIfRequested(options.signal);
      const parsed = mediaCreateRequestSchema.parse(input);
      const expectedParts = Math.ceil(
        parsed.expectedBytes / this.#partSizeBytes,
      );
      if (expectedParts > MAX_MEDIA_PARTS) {
        throw new MediaStagingError(
          "too_many_parts",
          "Media upload would exceed the supported part count.",
        );
      }
      await this.#ensureRoot();
      const idempotencyDigest = digestText(parsed.idempotencyKey);
      const requestDigest = digestText(JSON.stringify({
        expectedBytes: parsed.expectedBytes,
        mimeType: parsed.mimeType,
        fileFingerprintSha256: parsed.fileFingerprintSha256,
        retention: parsed.retention,
      }));
      for (const existing of await this.#storedSessions()) {
        if (existing.idempotencyDigest !== idempotencyDigest) continue;
        if (existing.requestDigest !== requestDigest) {
          throw new MediaStagingError(
            "idempotency_conflict",
            "Media create key was already used for different input.",
          );
        }
        return existing.session;
      }

      const availableBytes = await this.#availableBytes();
      if (
        availableBytes < parsed.expectedBytes + this.#minimumFreeBytes
      ) {
        throw new MediaStagingError(
          "insufficient_disk",
          "Insufficient private disk space for this recording.",
        );
      }
      abortIfRequested(options.signal);
      const id = this.#parseId(this.#createId());
      if (!id.startsWith("media_")) {
        throw new MediaStagingError(
          "invalid_media_id",
          "Generated media identifier must use the media prefix.",
        );
      }
      if (await optionalStat(this.#sessionDirectory(id))) {
        throw new MediaStagingError(
          "media_id_collision",
          "Generated media identifier already exists.",
        );
      }
      const createdAt = this.#now();
      const retention = parsed.retention.mode === "retained"
        ? {
            mode: "retained" as const,
            expiresAt: new Date(
              createdAt.getTime() + parsed.retention.ttlSeconds * 1_000,
            ).toISOString(),
          }
        : {
            mode: "ephemeral" as const,
            expiresAt: new Date(
              createdAt.getTime() + this.#uploadTtlSeconds * 1_000,
            ).toISOString(),
          };
      const session = mediaSessionSchema.parse({
        id,
        status: "created",
        expectedBytes: parsed.expectedBytes,
        receivedBytes: 0,
        partSizeBytes: this.#partSizeBytes,
        parts: [],
        mimeType: parsed.mimeType,
        fileFingerprintSha256: parsed.fileFingerprintSha256,
        retention,
        uploadExpiresAt: new Date(
          createdAt.getTime() + this.#uploadTtlSeconds * 1_000,
        ).toISOString(),
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      });
      await this.#writeStored({
        schemaVersion: 1,
        idempotencyDigest,
        requestDigest,
        session,
      });
      return session;
    });
  }

  async get(id: string): Promise<MediaSession | undefined> {
    await this.#ensureRoot();
    return (await this.#readStored(this.#parseId(id)))?.session;
  }

  /**
   * Resolves the private recording path only while execution owns the receipt.
   *
   * This capability is intentionally absent from the shared
   * MediaStagingAdapter and every HTTP response.
   */
  async resolveInUsePath(
    idValue: string,
    expectedSha256: string,
  ): Promise<string> {
    const id = this.#parseId(idValue);
    sha256Schema.parse(expectedSha256);
    await this.#ensureRoot();
    const stored = await this.#requireStored(id);
    if (
      stored.session.status !== "in_use"
      || stored.session.sha256 !== expectedSha256
    ) {
      throw new MediaStagingError(
        "media_path_unavailable",
        "Staged media is not leased for this execution.",
      );
    }
    const path = this.#sealedPath(id);
    const before = await lstat(path);
    assertRegularFile(before);
    if (before.size !== stored.session.expectedBytes) {
      throw new MediaStagingError(
        "staging_inconsistent",
        "Sealed media size does not match its durable receipt.",
      );
    }
    const canonical = await realpath(path);
    const canonicalSessionDirectory = await realpath(
      this.#sessionDirectory(id),
    );
    if (canonical !== join(canonicalSessionDirectory, "media.sealed")) {
      throw new MediaStagingError(
        "unsafe_staging_file",
        "Sealed media resolved outside its private receipt path.",
      );
    }
    const after = await lstat(canonical);
    assertRegularFile(after);
    if (!sameFile(before, after)) {
      throw new MediaStagingError(
        "unsafe_staging_file",
        "Sealed media identity changed while resolving it.",
      );
    }
    const verified = await this.#streamedDigest(canonical);
    const final = await lstat(canonical);
    assertRegularFile(final);
    if (
      !sameFile(before, final)
      || verified.bytes !== stored.session.expectedBytes
      || verified.sha256 !== expectedSha256
    ) {
      throw new MediaStagingError(
        "media_digest_mismatch",
        "Sealed media no longer matches its durable receipt.",
      );
    }
    return canonical;
  }

  async #hashIncomingPart(
    bytes: BinaryChunkSource,
    contentLength: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of bytes) {
      abortIfRequested(signal);
      if (!(chunk instanceof Uint8Array)) {
        throw new MediaStagingError(
          "invalid_part_chunk",
          "Media part contained a non-binary chunk.",
        );
      }
      received += chunk.byteLength;
      if (received > contentLength) {
        throw new MediaStagingError(
          "part_size_mismatch",
          "Media part exceeded its declared size.",
        );
      }
      hash.update(chunk);
    }
    if (received !== contentLength) {
      throw new MediaStagingError(
        "part_size_mismatch",
        "Media part did not match its declared size.",
      );
    }
    return hash.digest("hex");
  }

  async writePart(
    idValue: string,
    input: MediaPartInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<MediaPartWriteResult> {
    const id = this.#parseId(idValue);
    if (this.#activeWriters.has(id)) {
      throw new MediaStagingError(
        "concurrent_writer",
        "Another writer already owns this media session.",
      );
    }
    this.#activeWriters.add(id);
    try {
      abortIfRequested(options.signal);
      const stored = await this.#requireStored(id);
      const session = stored.session;
      if (
        session.uploadExpiresAt
        && Date.parse(session.uploadExpiresAt) <= this.#now().getTime()
      ) {
        const expired = await this.#setStatus(stored, "expired");
        await this.#delete(expired.session.id, { allowActiveWriter: true });
        throw new MediaStagingError(
          "media_expired",
          "Media upload session has expired.",
        );
      }
      if (
        !Number.isSafeInteger(input.part)
        || !Number.isSafeInteger(input.offset)
        || !Number.isSafeInteger(input.contentLength)
        || input.part < 0
        || input.offset < 0
        || input.contentLength <= 0
      ) {
        throw new MediaStagingError(
          "invalid_part",
          "Media part coordinates are invalid.",
        );
      }

      const priorReceipt = session.parts[input.part];
      if (priorReceipt) {
        const incomingDigest = await this.#hashIncomingPart(
          input.bytes,
          input.contentLength,
          options.signal,
        );
        if (
          input.offset !== priorReceipt.offset
          || input.contentLength !== priorReceipt.bytes
          || incomingDigest !== priorReceipt.sha256
        ) {
          throw new MediaStagingError(
            "part_conflict",
            "Media part retry did not match its durable receipt.",
          );
        }
        return {
          session,
          receipt: priorReceipt,
          replayed: true,
        };
      }

      if (!["created", "uploading"].includes(session.status)) {
        throw new MediaStagingError(
          "media_not_uploadable",
          "Media session no longer accepts parts.",
        );
      }
      const expectedPart = session.parts.length;
      const expectedOffset = expectedPart * session.partSizeBytes;
      const expectedBytes = Math.min(
        session.partSizeBytes,
        session.expectedBytes - expectedOffset,
      );
      if (
        input.part !== expectedPart
        || input.offset !== expectedOffset
      ) {
        throw new MediaStagingError(
          "part_out_of_order",
          "Media parts must be uploaded in contiguous order.",
        );
      }
      if (input.contentLength !== expectedBytes) {
        throw new MediaStagingError(
          "part_size_mismatch",
          "Media part length did not match the server receipt.",
        );
      }

      const partialPath = this.#partialPath(id);
      const before = await optionalStat(partialPath);
      if (before) {
        assertRegularFile(before);
        if (before.size !== session.receivedBytes) {
          throw new MediaStagingError(
            "staging_inconsistent",
            "Media partial file does not match its durable receipt.",
          );
        }
      } else if (session.receivedBytes !== 0) {
        throw new MediaStagingError(
          "staging_inconsistent",
          "Media partial file is missing.",
        );
      }

      const flags = constants.O_WRONLY
        | constants.O_APPEND
        | constants.O_CREAT
        | (constants.O_NOFOLLOW ?? 0);
      const handle = await open(partialPath, flags, 0o600);
      const opened = await handle.stat();
      if (!opened.isFile() || (before && !sameFile(before, opened))) {
        await handle.close();
        throw new MediaStagingError(
          "unsafe_staging_file",
          "Media staging file identity changed.",
        );
      }
      const writer = Bun.file(handle.fd).writer({
        highWaterMark: FILE_SINK_HIGH_WATER_MARK,
      });
      const hash = createHash("sha256");
      let received = 0;
      let ended = false;
      try {
        for await (const chunk of input.bytes) {
          abortIfRequested(options.signal);
          if (!(chunk instanceof Uint8Array)) {
            throw new MediaStagingError(
              "invalid_part_chunk",
              "Media part contained a non-binary chunk.",
            );
          }
          received += chunk.byteLength;
          if (received > expectedBytes) {
            throw new MediaStagingError(
              "part_size_mismatch",
              "Media part exceeded its declared size.",
            );
          }
          hash.update(chunk);
          const result = await writer.write(chunk);
          if (typeof result === "number" && result < 0) {
            await writer.flush();
          }
        }
        if (received !== expectedBytes) {
          throw new MediaStagingError(
            "part_size_mismatch",
            "Media part did not match its declared size.",
          );
        }
        await writer.flush();
        await handle.sync();
        await writer.end();
        ended = true;
        await handle.close();

        const after = await lstat(partialPath);
        assertRegularFile(after);
        if (after.size !== session.receivedBytes + expectedBytes) {
          throw new MediaStagingError(
            "staging_inconsistent",
            "Media partial file size changed unexpectedly.",
          );
        }
        const receivedAt = this.#now().toISOString();
        const receipt = {
          part: input.part,
          offset: input.offset,
          bytes: expectedBytes,
          sha256: hash.digest("hex"),
          receivedAt,
        };
        const nextSession = mediaSessionSchema.parse({
          ...session,
          status: "uploading",
          receivedBytes: session.receivedBytes + expectedBytes,
          parts: [...session.parts, receipt],
          updatedAt: receivedAt,
        });
        try {
          await this.#writeStored({ ...stored, session: nextSession });
        } catch (error) {
          await truncate(partialPath, session.receivedBytes);
          throw error;
        }
        return {
          session: nextSession,
          receipt,
          replayed: false,
        };
      } catch (error) {
        if (!ended) {
          try {
            await writer.end(error instanceof Error ? error : undefined);
          } catch {
            // Preserve the original bounded write failure.
          }
          try {
            await handle.close();
          } catch {
            // The FileSink may already have closed the shared descriptor.
          }
        }
        try {
          await truncate(partialPath, session.receivedBytes);
        } catch {
          // A subsequent reconciliation will preserve the receipt as authority.
        }
        if (error instanceof MediaStagingError) throw error;
        if (errorCode(error) === "enospc") {
          throw new MediaStagingError(
            "disk_exhausted",
            "Disk space was exhausted while staging media.",
          );
        }
        throw new MediaStagingError(
          "part_write_failed",
          "Media part could not be written.",
        );
      }
    } finally {
      this.#activeWriters.delete(id);
    }
  }

  async #streamedDigest(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ sha256: string; bytes: number; prefix: Uint8Array }> {
    const hash = createHash("sha256");
    const prefix = new Uint8Array(12);
    let prefixBytes = 0;
    let bytes = 0;
    for await (const value of Bun.file(path).stream()) {
      abortIfRequested(signal);
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
      if (prefixBytes < prefix.byteLength) {
        const copied = Math.min(prefix.byteLength - prefixBytes, chunk.byteLength);
        prefix.set(chunk.subarray(0, copied), prefixBytes);
        prefixBytes += copied;
      }
      bytes += chunk.byteLength;
      hash.update(chunk);
    }
    return {
      sha256: hash.digest("hex"),
      bytes,
      prefix: prefix.subarray(0, prefixBytes),
    };
  }

  async seal(
    idValue: string,
    options: { expectedSha256?: string; signal?: AbortSignal } = {},
  ): Promise<MediaSealReceipt> {
    const id = this.#parseId(idValue);
    if (this.#activeWriters.has(id)) {
      throw new MediaStagingError(
        "concurrent_writer",
        "Another writer already owns this media session.",
      );
    }
    this.#activeWriters.add(id);
    try {
      abortIfRequested(options.signal);
      if (options.expectedSha256) {
        sha256Schema.parse(options.expectedSha256);
      }
      const stored = await this.#requireStored(id);
      const session = stored.session;
      if (
        session.uploadExpiresAt
        && Date.parse(session.uploadExpiresAt) <= this.#now().getTime()
      ) {
        const expired = await this.#setStatus(stored, "expired");
        await this.#delete(expired.session.id, { allowActiveWriter: true });
        throw new MediaStagingError(
          "media_expired",
          "Media upload session has expired.",
        );
      }
      if (session.status === "sealed") {
        if (
          options.expectedSha256
          && options.expectedSha256 !== session.sha256
        ) {
          throw new MediaStagingError(
            "digest_mismatch",
            "Media digest did not match the expected recording.",
          );
        }
        return {
          mediaSessionId: id,
          sha256: session.sha256!,
          bytes: session.receivedBytes,
          mimeType: session.mimeType,
          sealedAt: session.updatedAt,
        };
      }
      if (
        session.status !== "uploading"
        || session.receivedBytes !== session.expectedBytes
        || session.parts.length
          !== Math.ceil(session.expectedBytes / session.partSizeBytes)
      ) {
        throw new MediaStagingError(
          "media_incomplete",
          "Media session is not complete enough to seal.",
        );
      }
      if (
        session.fileFingerprintSha256
        && digestText(session.parts.map((part) => part.sha256).join(""))
          !== session.fileFingerprintSha256
      ) {
        throw new MediaStagingError(
          "file_fingerprint_mismatch",
          "Uploaded parts do not match the recording selected at creation.",
        );
      }

      const partialPath = this.#partialPath(id);
      const before = await lstat(partialPath);
      assertRegularFile(before);
      if (before.size !== session.expectedBytes) {
        throw new MediaStagingError(
          "staging_inconsistent",
          "Media partial file size did not match the session.",
        );
      }
      const final = await this.#streamedDigest(partialPath, options.signal);
      const after = await lstat(partialPath);
      assertRegularFile(after);
      if (!sameFile(before, after) || final.bytes !== session.expectedBytes) {
        throw new MediaStagingError(
          "unsafe_staging_file",
          "Media staging file changed during sealing.",
        );
      }
      if (
        options.expectedSha256
        && final.sha256 !== options.expectedSha256
      ) {
        throw new MediaStagingError(
          "digest_mismatch",
          "Media digest did not match the expected recording.",
        );
      }
      if (detectedMimeType(final.prefix) !== session.mimeType) {
        throw new MediaStagingError(
          "mime_mismatch",
          "Detected recording type did not match the declared media type.",
        );
      }

      const sealedPath = this.#sealedPath(id);
      if (await optionalStat(sealedPath)) {
        throw new MediaStagingError(
          "staging_inconsistent",
          "A sealed media file already exists.",
        );
      }
      await rename(partialPath, sealedPath);
      const sealedAt = this.#now().toISOString();
      const nextSession = mediaSessionSchema.parse({
        ...session,
        status: "sealed",
        sha256: final.sha256,
        uploadExpiresAt: undefined,
        updatedAt: sealedAt,
      });
      try {
        await this.#writeStored({ ...stored, session: nextSession });
      } catch (error) {
        try {
          await rename(sealedPath, partialPath);
        } catch {
          // Startup reconciliation handles a sealed file without its receipt.
        }
        throw error;
      }
      return {
        mediaSessionId: id,
        sha256: final.sha256,
        bytes: final.bytes,
        mimeType: session.mimeType,
        sealedAt,
      };
    } finally {
      this.#activeWriters.delete(id);
    }
  }

  async transition(
    transition: ValidatedMediaTransition,
  ): Promise<MediaSession> {
    const id = this.#parseId(transition.id);
    if (this.#activeWriters.has(id)) {
      throw new MediaStagingError(
        "concurrent_writer",
        "Another writer already owns this media session.",
      );
    }
    this.#activeWriters.add(id);
    try {
      const stored = await this.#requireStored(id);
      if (stored.session.status !== transition.expected) {
        throw new MediaStagingError(
          "media_state_conflict",
          "Media session state changed before the requested transition.",
        );
      }
      if (
        transition.next === "retained"
        && stored.session.retention.mode !== "retained"
      ) {
        throw new MediaStagingError(
          "retention_not_requested",
          "Ephemeral media cannot become retained.",
        );
      }
      if (
        stored.session.retention.mode === "retained"
        && Date.parse(stored.session.retention.expiresAt)
          <= this.#now().getTime()
        && transition.next === "in_use"
      ) {
        throw new MediaStagingError(
          "media_expired",
          "Retained media has expired.",
        );
      }
      const updatedAt = this.#now().toISOString();
      const session = mediaSessionSchema.parse({
        ...stored.session,
        status: transition.next,
        uploadExpiresAt: ["created", "uploading"].includes(transition.next)
          ? stored.session.uploadExpiresAt
          : undefined,
        cleanupFailureCode: transition.next === "cleanup_failed"
          ? stored.session.cleanupFailureCode
          : undefined,
        updatedAt,
      });
      await this.#writeStored({ ...stored, session });
      return session;
    } finally {
      this.#activeWriters.delete(id);
    }
  }

  async #setStatus(
    stored: StoredMediaSession,
    status: MediaSession["status"],
    additions: Partial<MediaSession> = {},
  ): Promise<StoredMediaSession> {
    assertMediaSessionTransition(stored.session.status, status);
    const session = mediaSessionSchema.parse({
      ...stored.session,
      ...additions,
      status,
      uploadExpiresAt: ["created", "uploading"].includes(status)
        ? stored.session.uploadExpiresAt
        : undefined,
      updatedAt: this.#now().toISOString(),
    });
    const next = { ...stored, session };
    await this.#writeStored(next);
    return next;
  }

  async delete(idValue: string): Promise<MediaSession> {
    return this.#delete(idValue);
  }

  async deleteEphemeralExecutionLease(
    idValue: string,
    expectedSha256: string,
  ): Promise<MediaSession> {
    sha256Schema.parse(expectedSha256);
    return this.#delete(idValue, { executionDigest: expectedSha256 });
  }

  async #delete(
    idValue: string,
    options: {
      allowActiveWriter?: boolean;
      executionDigest?: string;
    } = {},
  ): Promise<MediaSession> {
    const id = this.#parseId(idValue);
    if (this.#activeWriters.has(id) && !options.allowActiveWriter) {
      throw new MediaStagingError(
        "concurrent_writer",
        "Media is still being written or sealed. Retry deletion shortly.",
      );
    }
    if (!options.allowActiveWriter) this.#activeWriters.add(id);
    try {
      let stored = await this.#requireStored(id);
      if (stored.session.status === "deleted") return stored.session;
      if (stored.session.status === "in_use") {
        if (!options.executionDigest) {
          throw new MediaStagingError(
            "media_in_use",
            "Media is leased by an active analysis.",
          );
        }
        if (
          stored.session.retention.mode !== "ephemeral"
          || stored.session.sha256 !== options.executionDigest
        ) {
          throw new MediaStagingError(
            "media_execution_lease_mismatch",
            "Media execution lease does not match its receipt.",
          );
        }
      } else if (options.executionDigest) {
        throw new MediaStagingError(
          "media_execution_lease_mismatch",
          "Media execution lease is no longer active.",
        );
      }
      if (stored.session.status === "failed") {
        throw new MediaStagingError(
          "media_terminal_failure",
          "Terminally failed media cannot be deleted automatically.",
        );
      }
      if (["created", "uploading"].includes(stored.session.status)) {
        stored = await this.#setStatus(stored, "aborted");
      }
      if (stored.session.status !== "deleting") {
        stored = await this.#setStatus(stored, "deleting", {
          cleanupFailureCode: undefined,
        });
      }
      try {
        assertPrivateDirectory(await lstat(this.#sessionDirectory(id)));
        await this.#removeFile(this.#partialPath(id));
        await this.#removeFile(this.#sealedPath(id));
      } catch (error) {
        const session = mediaSessionSchema.parse({
          ...stored.session,
          status: "cleanup_failed",
          cleanupFailureCode: errorCode(error),
          updatedAt: this.#now().toISOString(),
        });
        await this.#writeStored({ ...stored, session });
        throw new MediaStagingError(
          "cleanup_failed",
          "Staged media cleanup failed and can be retried.",
        );
      }
      stored = await this.#setStatus(stored, "deleted", {
        cleanupFailureCode: undefined,
      });
      return stored.session;
    } finally {
      if (!options.allowActiveWriter) this.#activeWriters.delete(id);
    }
  }

  async abort(idValue: string): Promise<MediaSession> {
    const id = this.#parseId(idValue);
    const stored = await this.#requireStored(id);
    if (stored.session.status === "deleted") return stored.session;
    return this.delete(id);
  }

  async expire(): Promise<MediaSession[]> {
    const expired: MediaSession[] = [];
    const now = this.#now().getTime();
    const candidates = (await this.#storedSessions()).filter(
      (candidate) => isMediaExpiryCandidate(candidate.session, now),
    );
    for (const candidate of candidates) {
      const id = candidate.session.id;
      if (this.#activeWriters.has(id)) continue;
      this.#activeWriters.add(id);
      try {
        let stored = await this.#requireStored(id);
        if (!isMediaExpiryCandidate(stored.session, now)) continue;
        const cleanupPending = ["expired", "deleting", "cleanup_failed"]
          .includes(stored.session.status);
        if (!cleanupPending) {
          stored = await this.#setStatus(stored, "expired");
        }
        try {
          expired.push(await this.#delete(id, { allowActiveWriter: true }));
        } catch (error) {
          if (
            error instanceof MediaStagingError
            && error.code === "cleanup_failed"
          ) {
            expired.push((await this.#requireStored(id)).session);
            continue;
          }
          throw error;
        }
      } finally {
        this.#activeWriters.delete(id);
      }
    }
    return expired;
  }

  async reconcile(): Promise<{
    repaired: string[];
    deleted: string[];
    failed: string[];
  }> {
    const report = {
      repaired: [] as string[],
      deleted: [] as string[],
      failed: [] as string[],
    };
    for (let stored of await this.#storedSessions()) {
      const id = stored.session.id;
      if (
        ["aborted", "expired", "deleting", "cleanup_failed"].includes(
          stored.session.status,
        )
      ) {
        try {
          await this.delete(id);
          report.deleted.push(id);
        } catch {
          report.failed.push(id);
        }
        continue;
      }
      if (["created", "uploading"].includes(stored.session.status)) {
        const partialPath = this.#partialPath(id);
        const partial = await optionalStat(partialPath);
        const sealed = await optionalStat(this.#sealedPath(id));
        if (
          sealed
          && stored.session.receivedBytes === stored.session.expectedBytes
        ) {
          assertRegularFile(sealed);
          if (partial) {
            await this.#setStatus(stored, "failed");
            report.failed.push(id);
            continue;
          }
          await rename(this.#sealedPath(id), partialPath);
          await this.seal(id);
          report.repaired.push(id);
          continue;
        }
        if (!partial && stored.session.receivedBytes > 0) {
          stored = await this.#setStatus(stored, "failed");
          report.failed.push(id);
          continue;
        }
        if (partial) {
          assertRegularFile(partial);
          if (partial.size < stored.session.receivedBytes) {
            stored = await this.#setStatus(stored, "failed");
            report.failed.push(id);
            continue;
          }
          if (partial.size > stored.session.receivedBytes) {
            await truncate(partialPath, stored.session.receivedBytes);
            report.repaired.push(id);
          }
        }
      }
      if (stored.session.status === "in_use") {
        if (stored.session.retention.mode === "retained") {
          stored = await this.#setStatus(stored, "retained");
          report.repaired.push(id);
        } else {
          try {
            if (!stored.session.sha256) {
              throw new MediaStagingError(
                "media_execution_lease_mismatch",
                "Abandoned media execution lease has no digest.",
              );
            }
            await this.#delete(id, {
              executionDigest: stored.session.sha256,
            });
            report.deleted.push(id);
          } catch {
            report.failed.push(id);
          }
          continue;
        }
      }
      if (
        ["sealed", "retained"].includes(stored.session.status)
        && !(await optionalStat(this.#sealedPath(id)))
      ) {
        await this.#setStatus(stored, "failed");
        report.failed.push(id);
      }
    }
    const expired = await this.expire();
    for (const session of expired) {
      if (session.status === "deleted") report.deleted.push(session.id);
      else report.failed.push(session.id);
    }
    return report;
  }
}
