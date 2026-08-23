const DEFAULT_GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
const FILE_NAME_PATTERN = /^files\/[A-Za-z0-9_-]+$/;
const PROVIDER_TIMEOUT_MS = 30_000;

export interface GeminiUploadSession {
  uploadUrl: string;
  partBytes: number;
  geminiFileName?: string;
}

export interface GeminiUploadQuery {
  status: "active" | "final";
  offset: number;
  geminiFileName?: string;
}

export interface GeminiFileMetadata {
  name: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hash?: string;
  expirationTime?: string;
}

export class HostedGeminiFilesError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostedGeminiFilesError";
  }
}

export class HostedGeminiFilesClient {
  private readonly origin: URL;

  constructor(
    private readonly apiKey: string,
    origin = DEFAULT_GEMINI_ORIGIN,
  ) {
    this.origin = new URL(origin);
    if (
      this.origin.username
      || this.origin.password
      || this.origin.search
      || this.origin.hash
      || (this.origin.protocol !== "https:"
        && !(this.origin.protocol === "http:"
          && ["127.0.0.1", "localhost"].includes(this.origin.hostname)))
    ) {
      throw new HostedGeminiFilesError("gemini_files_origin_invalid");
    }
  }

  async start(input: {
    mediaId: string;
    sizeBytes: number;
    mimeType: string;
  }): Promise<GeminiUploadSession> {
    const response = await fetch(new URL("/upload/v1beta/files", this.origin), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(input.sizeBytes),
        "x-goog-upload-header-content-type": input.mimeType,
      },
      body: JSON.stringify({ file: { display_name: input.mediaId } }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new HostedGeminiFilesError(`gemini_upload_start_http_${response.status}`);
    }
    const uploadUrl = response.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      throw new HostedGeminiFilesError("gemini_upload_start_url_missing");
    }
    this.requireSessionUrl(uploadUrl);
    const advertised = Number(
      response.headers.get("x-goog-upload-chunk-granularity"),
    );
    const partBytes = Number.isSafeInteger(advertised)
        && advertised >= 256 * 1_024
        && advertised % (256 * 1_024) === 0
      ? advertised
      : 256 * 1_024;
    return {
      uploadUrl,
      partBytes,
    };
  }

  async query(uploadUrl: string): Promise<GeminiUploadQuery> {
    this.requireSessionUrl(uploadUrl);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      redirect: "manual",
      headers: {
        "content-length": "0",
        "x-goog-upload-command": "query",
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new HostedGeminiFilesError(`gemini_upload_query_http_${response.status}`);
    }
    const status = response.headers.get("x-goog-upload-status");
    if (status !== "active" && status !== "final") {
      throw new HostedGeminiFilesError("gemini_upload_query_status_invalid");
    }
    const offset = Number(response.headers.get("x-goog-upload-size-received"));
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HostedGeminiFilesError("gemini_upload_query_offset_invalid");
    }
    const body = await response.text();
    const geminiFileName = fileNameFromBody(body);
    return {
      status,
      offset,
      ...(geminiFileName ? { geminiFileName } : {}),
    };
  }

  async get(name: string): Promise<GeminiFileMetadata> {
    requireFileName(name);
    const response = await fetch(new URL(`/v1beta/${name}`, this.origin), {
      method: "GET",
      redirect: "manual",
      headers: { "x-goog-api-key": this.apiKey },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new HostedGeminiFilesError(`gemini_files_get_http_${response.status}`);
    }
    const value = await response.json() as Record<string, unknown>;
    const sizeBytes = Number(value.sizeBytes);
    if (
      value.name !== name
      || typeof value.uri !== "string"
      || typeof value.mimeType !== "string"
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 0
    ) {
      throw new HostedGeminiFilesError("gemini_files_get_invalid");
    }
    return {
      name,
      uri: value.uri,
      mimeType: value.mimeType,
      sizeBytes,
      ...(typeof value.sha256Hash === "string"
        ? { sha256Hash: value.sha256Hash }
        : {}),
      ...(typeof value.expirationTime === "string"
        ? { expirationTime: value.expirationTime }
        : {}),
    };
  }

  async deleteFile(name: string): Promise<void> {
    requireFileName(name);
    const response = await fetch(new URL(`/v1beta/${name}`, this.origin), {
      method: "DELETE",
      redirect: "manual",
      headers: { "x-goog-api-key": this.apiKey },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      throw new HostedGeminiFilesError(`gemini_files_delete_http_${response.status}`);
    }
  }

  async abandon(
    uploadUrl: string,
    knownName?: string,
  ): Promise<"deleted" | "provider_ttl"> {
    this.requireSessionUrl(uploadUrl);
    if (knownName) {
      await this.deleteFile(knownName);
      return "deleted";
    }
    const query = await this.query(uploadUrl);
    if (query.status === "active") {
      // Gemini exposes no File identity and no documented resumable-session
      // revoke before finalize. The D1 state is abandoned immediately and the
      // opaque provider capability is left to its bounded provider TTL.
      return "provider_ttl";
    }
    if (!query.geminiFileName) {
      throw new HostedGeminiFilesError("gemini_upload_final_name_missing");
    }
    await this.deleteFile(query.geminiFileName);
    return "deleted";
  }

  private requireSessionUrl(value: string): void {
    const candidate = new URL(value);
    if (
      candidate.origin !== this.origin.origin
      || candidate.username
      || candidate.password
      || candidate.hash
      || !candidate.searchParams.has("upload_id")
      || candidate.searchParams.get("upload_protocol") !== "resumable"
      || [...candidate.searchParams.keys()].some((key) =>
        ["key", "api_key", "access_token", "authorization"].includes(
          key.toLowerCase(),
        )
      )
    ) {
      throw new HostedGeminiFilesError("gemini_upload_session_url_invalid");
    }
  }
}

function fileNameFromBody(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const value = JSON.parse(body) as { file?: { name?: unknown }; name?: unknown };
    const name = value.file?.name ?? value.name;
    return typeof name === "string" && FILE_NAME_PATTERN.test(name)
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}

function requireFileName(name: string): void {
  if (!FILE_NAME_PATTERN.test(name)) {
    throw new HostedGeminiFilesError("gemini_file_name_invalid");
  }
}
