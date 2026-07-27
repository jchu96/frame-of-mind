import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import type {
  ContextFileCreateInput,
  ContextFileReceipt,
  ContextFileStagingAdapter,
} from "../../../../src/domain/studio-ports";
import {
  contextFileReceiptSchema,
  contextFileFormatSchema,
  MAX_CONTEXT_FILE_BYTES,
} from "../../../../src/domain/studio-schemas";
import {
  parseOpaqueResourceId,
  type OpaqueResourceId,
} from "../../../../src/domain/studio-identifiers";
import { parseCaptionTranscript } from "../../../../src/adapters/file-context.js";

const DEFAULT_CONTEXT_TTL_SECONDS = 60 * 60;
const MAX_CONTEXT_TTL_SECONDS = 24 * 60 * 60;

const storedContextFileSchema = z.object({
  schemaVersion: z.literal(1),
  receipt: contextFileReceiptSchema,
}).strict();

type StoredContextFile = z.infer<typeof storedContextFileSchema>;

const extensionByFormat = {
  json: ".json",
  text: ".txt",
  markdown: ".md",
  srt: ".srt",
  vtt: ".vtt",
} as const;

export class ContextFileStagingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContextFileStagingError";
  }
}

export interface LocalContextFileStagingOptions {
  rootDirectory: string;
  checkoutRoot?: string;
  maxBytes?: number;
  ttlSeconds?: number;
  now?: () => Date;
  createId?: () => string;
}

export interface ContextFileLease {
  path: string;
  receipt: ContextFileReceipt;
  release(): Promise<void>;
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

function isInside(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return !childRelative
    || (
      childRelative !== ".."
      && !childRelative.startsWith(`..${sep}`)
      && !isAbsolute(childRelative)
    );
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ContextFileStagingError(
      "aborted",
      "Context-file staging was aborted.",
    );
  }
}

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "enoent") return undefined;
    throw error;
  }
}

function assertPrivateDirectory(
  value: Awaited<ReturnType<typeof lstat>>,
): void {
  if (value.isSymbolicLink() || !value.isDirectory()) {
    throw new ContextFileStagingError(
      "unsafe_context_file",
      "Context staging encountered an unsafe directory.",
    );
  }
}

function assertRegularFile(
  value: Awaited<ReturnType<typeof lstat>>,
): void {
  if (value.isSymbolicLink() || !value.isFile()) {
    throw new ContextFileStagingError(
      "unsafe_context_file",
      "Context staging encountered an unsafe file replacement.",
    );
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  if (process.platform === "win32") return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function validateContextContent(
  format: ContextFileReceipt["format"],
  bytes: Uint8Array,
): void {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContextFileStagingError(
      "invalid_context_content",
      "Context file must contain valid UTF-8 text.",
    );
  }
  if (content.includes("\u0000")) {
    throw new ContextFileStagingError(
      "invalid_context_content",
      "Context file contains unsupported control bytes.",
    );
  }
  if (format === "json") {
    try {
      JSON.parse(content);
    } catch {
      throw new ContextFileStagingError(
        "invalid_context_content",
        "Context file must contain valid JSON.",
      );
    }
  }
  if (
    (format === "srt" || format === "vtt")
    && !parseCaptionTranscript(content)
  ) {
    throw new ContextFileStagingError(
      "invalid_context_content",
      "Caption context must contain at least one timed cue.",
    );
  }
}

export class LocalContextFileStagingAdapter
  implements ContextFileStagingAdapter {
  readonly #rootDirectory: string;
  readonly #filesDirectory: string;
  readonly #checkoutRoot: string;
  readonly #maxBytes: number;
  readonly #ttlSeconds: number;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #activeLeases = new Set<string>();
  readonly #activeTemporaryDirectories = new Set<string>();

  constructor(options: LocalContextFileStagingOptions) {
    const rootDirectory = resolve(options.rootDirectory);
    const checkoutRoot = resolve(options.checkoutRoot ?? process.cwd());
    if (isInside(checkoutRoot, rootDirectory)) {
      throw new ContextFileStagingError(
        "unsafe_staging_root",
        "Context staging must live outside the source checkout.",
      );
    }
    const maxBytes = options.maxBytes ?? MAX_CONTEXT_FILE_BYTES;
    if (
      !Number.isSafeInteger(maxBytes)
      || maxBytes < 1
      || maxBytes > MAX_CONTEXT_FILE_BYTES
    ) {
      throw new ContextFileStagingError(
        "invalid_context_bounds",
        "Context-file byte limit is invalid.",
      );
    }
    const ttlSeconds = options.ttlSeconds ?? DEFAULT_CONTEXT_TTL_SECONDS;
    if (
      !Number.isSafeInteger(ttlSeconds)
      || ttlSeconds < 1
      || ttlSeconds > MAX_CONTEXT_TTL_SECONDS
    ) {
      throw new ContextFileStagingError(
        "invalid_context_bounds",
        "Context-file TTL is invalid.",
      );
    }

    this.#rootDirectory = rootDirectory;
    this.#filesDirectory = join(rootDirectory, "files");
    this.#checkoutRoot = checkoutRoot;
    this.#maxBytes = maxBytes;
    this.#ttlSeconds = ttlSeconds;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId
      ?? (() => `context_${randomBytes(18).toString("base64url")}`);
  }

  async stage(
    input: ContextFileCreateInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ContextFileReceipt> {
    const format = contextFileFormatSchema.safeParse(input.format);
    if (!format.success) {
      throw new ContextFileStagingError(
        "unsupported_context_format",
        "Context-file format is unsupported.",
      );
    }
    if (
      !Number.isSafeInteger(input.expectedBytes)
      || input.expectedBytes < 1
      || input.expectedBytes > this.#maxBytes
    ) {
      throw new ContextFileStagingError(
        "context_too_large",
        "Context-file length is outside the supported range.",
      );
    }
    abortIfRequested(options.signal);
    await this.#ensureRoot();

    const id = this.#parseId(this.#createId());
    const finalDirectory = this.#fileDirectory(id);
    if (await optionalStat(finalDirectory)) {
      throw new ContextFileStagingError(
        "context_id_collision",
        "Context-file identifier collided with an existing receipt.",
      );
    }
    const temporaryDirectory = join(
      this.#filesDirectory,
      `.stage-${randomBytes(12).toString("hex")}`,
    );
    this.#activeTemporaryDirectories.add(temporaryDirectory);
    try {
      await mkdir(temporaryDirectory, { mode: 0o700 });
    } catch (error) {
      this.#activeTemporaryDirectories.delete(temporaryDirectory);
      throw new ContextFileStagingError(
        errorCode(error) === "enospc"
          ? "disk_exhausted"
          : "context_write_failed",
        "Context-file staging failed.",
      );
    }
    const contentPath = join(
      temporaryDirectory,
      `context${extensionByFormat[format.data]}`,
    );
    const digest = createHash("sha256");
    let bytesWritten = 0;
    let handle;
    try {
      handle = await open(
        contentPath,
        constants.O_CREAT
          | constants.O_EXCL
          | constants.O_WRONLY
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      for await (const chunk of input.bytes) {
        abortIfRequested(options.signal);
        if (!(chunk instanceof Uint8Array)) {
          throw new ContextFileStagingError(
            "invalid_context_chunk",
            "Context-file stream produced an invalid chunk.",
          );
        }
        if (chunk.byteLength === 0) continue;
        bytesWritten += chunk.byteLength;
        if (
          bytesWritten > input.expectedBytes
          || bytesWritten > this.#maxBytes
        ) {
          throw new ContextFileStagingError(
            "context_too_large",
            "Context-file stream exceeded its declared length.",
          );
        }
        await handle.write(chunk);
        digest.update(chunk);
      }
      abortIfRequested(options.signal);
      if (bytesWritten !== input.expectedBytes) {
        throw new ContextFileStagingError(
          "context_byte_count_mismatch",
          "Context-file stream did not match its declared length.",
        );
      }
      await handle.sync();
      await handle.close();
      handle = undefined;

      const verificationHandle = await open(
        contentPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let content: Uint8Array;
      try {
        content = new Uint8Array(await verificationHandle.readFile());
      } finally {
        await verificationHandle.close();
      }
      validateContextContent(format.data, content);

      const receipt = contextFileReceiptSchema.parse({
        id,
        format: format.data,
        bytes: bytesWritten,
        sha256: digest.digest("hex"),
        expiresAt: new Date(
          this.#now().getTime() + this.#ttlSeconds * 1_000,
        ).toISOString(),
      });
      await writeFile(
        join(temporaryDirectory, "receipt.json"),
        `${JSON.stringify({ schemaVersion: 1, receipt })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporaryDirectory, finalDirectory);
      return receipt;
    } catch (error) {
      if (error instanceof ContextFileStagingError) throw error;
      throw new ContextFileStagingError(
        errorCode(error) === "enospc"
          ? "disk_exhausted"
          : "context_write_failed",
        "Context-file staging failed.",
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryDirectory, { recursive: true, force: true })
        .catch(() => undefined);
      this.#activeTemporaryDirectories.delete(temporaryDirectory);
    }
  }

  async get(id: string): Promise<ContextFileReceipt | undefined> {
    let parsedId: OpaqueResourceId;
    try {
      parsedId = this.#parseId(id);
    } catch {
      return undefined;
    }
    const stored = await this.#readStored(parsedId);
    if (!stored) return undefined;
    if (Date.parse(stored.receipt.expiresAt) <= this.#now().getTime()) {
      if (!this.#activeLeases.has(parsedId)) {
        await this.#deleteParsed(parsedId);
      }
      return undefined;
    }
    await this.#verifyContent(parsedId, stored.receipt);
    return stored.receipt;
  }

  async resolvePath(id: string): Promise<string> {
    const receipt = await this.get(id);
    if (!receipt) {
      throw new ContextFileStagingError(
        "context_not_found",
        "Context file was not found or has expired.",
      );
    }
    return this.#contentPath(this.#parseId(id), receipt.format);
  }

  async acquire(id: string): Promise<ContextFileLease> {
    if (this.#activeLeases.has(id)) {
      throw new ContextFileStagingError(
        "context_in_use",
        "Context file is already in use.",
      );
    }
    this.#activeLeases.add(id);
    let receipt: ContextFileReceipt;
    try {
      const available = await this.get(id);
      if (!available) {
        throw new ContextFileStagingError(
          "context_not_found",
          "Context file was not found or has expired.",
        );
      }
      receipt = available;
    } catch (error) {
      this.#activeLeases.delete(id);
      throw error;
    }
    let released = false;
    return {
      path: this.#contentPath(this.#parseId(id), receipt.format),
      receipt,
      release: async () => {
        if (released) return;
        released = true;
        this.#activeLeases.delete(id);
        await this.#deleteParsed(this.#parseId(id));
      },
    };
  }

  async delete(id: string): Promise<void> {
    let parsedId: OpaqueResourceId;
    try {
      parsedId = this.#parseId(id);
    } catch {
      return;
    }
    if (this.#activeLeases.has(parsedId)) {
      throw new ContextFileStagingError(
        "context_in_use",
        "Context file is currently in use.",
      );
    }
    await this.#deleteParsed(parsedId);
  }

  async expire(): Promise<string[]> {
    await this.#ensureRoot();
    const expired: string[] = [];
    let firstFailure: unknown;
    for (
      const entry of await readdir(this.#filesDirectory, {
        withFileTypes: true,
      })
    ) {
      if (entry.name.startsWith(".stage-")) {
        const path = join(this.#filesDirectory, entry.name);
        if (this.#activeTemporaryDirectories.has(path)) continue;
        await rm(path, {
          recursive: true,
          force: true,
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      let id: OpaqueResourceId;
      try {
        id = this.#parseId(entry.name);
      } catch {
        continue;
      }
      if (this.#activeLeases.has(id)) continue;
      try {
        const stored = await this.#readStored(id);
        if (
          stored
          && Date.parse(stored.receipt.expiresAt) <= this.#now().getTime()
        ) {
          await this.#deleteParsed(id);
          expired.push(id);
        }
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw firstFailure;
    return expired;
  }

  async #ensureRoot(): Promise<void> {
    const existingRoot = await optionalStat(this.#rootDirectory);
    if (existingRoot?.isSymbolicLink()) {
      throw new ContextFileStagingError(
        "unsafe_staging_root",
        "Context staging root must not be a symbolic link.",
      );
    }
    try {
      await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(this.#rootDirectory);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new ContextFileStagingError(
          "unsafe_staging_root",
          "Context staging root must be a private directory.",
        );
      }
      const canonicalRoot = await realpath(this.#rootDirectory);
      const canonicalCheckout = await realpath(this.#checkoutRoot);
      if (isInside(canonicalCheckout, canonicalRoot)) {
        throw new ContextFileStagingError(
          "unsafe_staging_root",
          "Context staging must resolve outside the source checkout.",
        );
      }
      if (process.platform !== "win32") {
        await chmod(this.#rootDirectory, 0o700);
      }
      await mkdir(this.#filesDirectory, { recursive: true, mode: 0o700 });
      assertPrivateDirectory(await lstat(this.#filesDirectory));
      if (process.platform !== "win32") {
        await chmod(this.#filesDirectory, 0o700);
      }
    } catch (error) {
      if (error instanceof ContextFileStagingError) throw error;
      throw new ContextFileStagingError(
        "unsafe_staging_root",
        "Context staging root could not be secured.",
      );
    }
  }

  #parseId(value: string): OpaqueResourceId {
    try {
      return parseOpaqueResourceId(value);
    } catch {
      throw new ContextFileStagingError(
        "invalid_context_id",
        "Context-file identifier is invalid.",
      );
    }
  }

  #fileDirectory(id: OpaqueResourceId): string {
    return join(this.#filesDirectory, id);
  }

  #receiptPath(id: OpaqueResourceId): string {
    return join(this.#fileDirectory(id), "receipt.json");
  }

  #contentPath(
    id: OpaqueResourceId,
    format: ContextFileReceipt["format"],
  ): string {
    return join(this.#fileDirectory(id), `context${extensionByFormat[format]}`);
  }

  async #readStored(id: OpaqueResourceId):
    Promise<StoredContextFile | undefined> {
    const directoryStat = await optionalStat(this.#fileDirectory(id));
    if (!directoryStat) return undefined;
    assertPrivateDirectory(directoryStat);
    const receiptPath = this.#receiptPath(id);
    const receiptStat = await optionalStat(receiptPath);
    if (!receiptStat) return undefined;
    assertRegularFile(receiptStat);
    let handle;
    try {
      handle = await open(
        receiptPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(receiptStat, opened)) {
        throw new ContextFileStagingError(
          "unsafe_context_file",
          "Context receipt identity changed while it was opened.",
        );
      }
      const stored = storedContextFileSchema.parse(
        JSON.parse(await handle.readFile("utf8")),
      );
      if (stored.receipt.id !== id) {
        throw new ContextFileStagingError(
          "corrupt_context_receipt",
          "Context-file receipt identity is inconsistent.",
        );
      }
      return stored;
    } catch (error) {
      if (error instanceof ContextFileStagingError) throw error;
      throw new ContextFileStagingError(
        "corrupt_context_receipt",
        "Context-file receipt is invalid.",
      );
    } finally {
      await handle?.close();
    }
  }

  async #verifyContent(
    id: OpaqueResourceId,
    receipt: ContextFileReceipt,
  ): Promise<void> {
    const contentPath = this.#contentPath(id, receipt.format);
    const contentStat = await optionalStat(contentPath);
    if (!contentStat) {
      throw new ContextFileStagingError(
        "context_not_found",
        "Context file is missing.",
      );
    }
    assertRegularFile(contentStat);
    let handle;
    try {
      handle = await open(
        contentPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(contentStat, opened)) {
        throw new ContextFileStagingError(
          "unsafe_context_file",
          "Context-file identity changed while it was opened.",
        );
      }
      if (opened.size !== receipt.bytes) {
        throw new ContextFileStagingError(
          "context_digest_mismatch",
          "Context-file bytes no longer match their receipt.",
        );
      }
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1_024);
      let position = 0;
      while (position < opened.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, opened.size - position),
          position,
        );
        if (bytesRead <= 0) break;
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (
        position !== opened.size
        || digest.digest("hex") !== receipt.sha256
      ) {
        throw new ContextFileStagingError(
          "context_digest_mismatch",
          "Context-file bytes no longer match their receipt.",
        );
      }
    } finally {
      await handle?.close();
    }
  }

  async #deleteParsed(id: OpaqueResourceId): Promise<void> {
    await rm(this.#fileDirectory(id), { recursive: true, force: true });
  }
}
