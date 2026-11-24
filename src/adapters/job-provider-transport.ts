import { closeSync, createReadStream, fstatSync } from "node:fs";
import { createGeminiFileUploader, type GeminiFileUploader } from "./gemini-files.js";
import { ContractError } from "../domain/contract-error.js";

export type JobDispatch = "start" | "finalize" | "poll" | "generate" | "delete";
export type DispatchJournal = (dispatch: JobDispatch, requests: number) => void;

/** One instance per admitted job. Both resumable POSTs and SDK requests pass
 * through this boundary. The journal must commit synchronously before fetch. */
export class JobProviderTransport {
  private requests = 0;
  private deleteHolds = 0;

  constructor(
    private readonly limit: number,
    private readonly maxFileBytes: number,
    private readonly retention: "provider" | "run",
    private readonly journal: DispatchJournal,
    private readonly openUpload: (path: string) => number,
    private readonly received?: (dispatch: JobDispatch, response: Response) => Promise<void>,
    private readonly authorize?: (dispatch: JobDispatch) => Promise<void>,
    private readonly lost?: () => void,
  ) {}

  uploader(apiKey: string): GeminiFileUploader {
    return {upload: async (path, mimeType) => {
      await this.authorize?.("start");
      const fd = this.openUpload(path);
      let streamOwnsFile = false;
      try {
        const size = fstatSync(fd).size;
        const uploader = createGeminiFileUploader(apiKey, {
          fetch: (url, init) => this.fetch(url, init as RequestInit),
          fileSize: async () => size,
          openFile: () => {
            const stream = createReadStream(path, {fd, autoClose: true, start: 0});
            streamOwnsFile = true;
            return stream;
          },
        });
        return await uploader.upload(path, mimeType);
      } finally {
        if (!streamOwnsFile) closeSync(fd);
      }
    }};
  }

  acquired() {
    if (this.retention === "provider") this.deleteHolds--;
  }

  async fetch(input: string | URL | Request, init: RequestInit = {}) {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://generativelanguage.googleapis.com" || url.username || url.password) {
      throw new ContractError("PROVIDER_REFUSED", "Unexpected provider destination.");
    }
    const headers = new Headers(init.headers);
    const command = headers.get("x-goog-upload-command");
    const op: JobDispatch = command === "start" ? "start" : command === "upload, finalize" ? "finalize"
      : init.method === "DELETE" ? "delete" : init.method === "GET" ? "poll" : "generate";
    if (op === "start" || op === "finalize") {
      const bytes = Number(headers.get(op === "start" ? "x-goog-upload-header-content-length" : "content-length"));
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.maxFileBytes) {
        throw new ContractError("FILE_LIMIT", "Upload exceeds the file grant.");
      }
    }
    await this.authorize?.(op);
    const holds = this.deleteHolds + (op === "start" ? 1 : op === "delete" ? -1 : 0);
    if (holds < 0 || this.requests + 1 + holds > this.limit) {
      throw new ContractError("PROVIDER_LIMIT", "The job has exhausted its request grant.");
    }
    this.journal(op, this.requests + 1);
    this.requests++;
    this.deleteHolds = holds;
    let response: Response;
    try {
      response = await fetch(url, {...init, redirect: "error"});
    } catch {
      this.lost?.();
      throw new ContractError("OUTCOME_UNKNOWN", "The provider reply was lost.");
    }
    // Headers alone do not acknowledge a finalized file or generation.
    // Keep the dispatch uncertain until the complete response can be read.
    if (this.received) {
      try { await response.clone().arrayBuffer(); }
      catch { this.lost?.(); throw new ContractError("OUTCOME_UNKNOWN", "The provider reply was incomplete."); }
      await this.received(op, response);
    }
    return response;
  }
}
