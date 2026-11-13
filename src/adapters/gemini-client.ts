import { GoogleGenAI } from "@google/genai";
import {
  hasConflictingProviderStatus,
  ProviderStatusConflictError,
} from "./gemini-error-class.js";

/**
 * @google/genai 2.21.0 has no public fetch hook and stringifies error envelopes
 * into ApiError.message. This per-client compatibility seam intercepts its
 * existing JSON read before that lossy conversion; it never reads message text
 * or changes global fetch. Real-SDK refusal tests pin the private apiCall seam.
 * Replace this shim with HttpOptions.fetch when adopting an SDK that supports it.
 */
export class StatusAwareGeminiClient extends GoogleGenAI {
  constructor(apiKey: string, timeout: number) {
    super({ apiKey, httpOptions: { timeout } });
    const transport = this.apiClient as unknown as {
      apiCall: (...args: unknown[]) => Promise<Response>;
    };
    if (typeof transport.apiCall !== "function") {
      throw new Error("Gemini SDK error transport hook is unavailable.");
    }
    const apiCall = transport.apiCall.bind(this.apiClient);
    transport.apiCall = async (...args) => {
      const response = await apiCall(...args);
      if (!response.ok && response.headers.get("content-type")?.includes("application/json")) {
        const readJson = response.json.bind(response);
        response.json = async () => {
          const body: unknown = await readJson();
          if (hasConflictingProviderStatus(response.status, body)) {
            throw new ProviderStatusConflictError(response.status);
          }
          return body;
        };
      }
      return response;
    };
  }
}
