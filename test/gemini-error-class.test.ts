import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApiError } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyProviderError } from "../src/adapters/gemini-error-class.js";
import { GeminiVideoAnalyzer } from "../src/adapters/gemini.js";
import { createGeminiFileUploader } from "../src/adapters/gemini-files.js";
import { Readable } from "node:stream";

// Files/non-streaming GenerateContent normalization and JSON envelope shape:
// https://github.com/googleapis/js-genai/blob/v2.21.0/src/_api_client.ts (throwErrorIfNotOK).
// Canonical status meanings/mappings: https://github.com/googleapis/googleapis/blob/master/google/rpc/code.proto
// Retry guidance: https://ai.google.dev/gemini-api/docs/troubleshooting . Its linked
// API-errors page describes Interactions, not HTTP-200 Files permission failures.
describe("classify", () => {
  it.each([[401, "refused"], [403, "refused"], [404, "not_found"], [429, "rate_limited"], [400, "other"], [503, "other"]] as const)
    ("%i is %s", (status, classification) => {
      expect(classifyProviderError(new ApiError({ status, message: "synthetic error" })))
        .toEqual({ class: classification, status });
    });

  it("contradictory structured statuses are other", () => {
    for (const error of [
      { status: 403, error: { code: 404, status: "NOT_FOUND" } },
      { status: 403, error: { code: 403, status: "NOT_FOUND" } },
      { status: 404, error: { code: 403 } },
      { status: 401, error: { status: "PERMISSION_DENIED" } },
      { status: 429, error: { code: "429" } },
      { status: 403, error: { status: "UNRECOGNIZED" } },
    ]) expect(classifyProviderError(error)).toEqual({ class: "other", status: error.status });
    expect(classifyProviderError({ error: { code: 403, status: "PERMISSION_DENIED" } })).toEqual({ class: "other" });
  });

  it("an error with no numeric status is other", () => {
    for (const error of [null, undefined, new Error("403 refused"), { status: "403" }, { status: NaN }, { status: Infinity }]) {
      expect(classifyProviderError(error)).toEqual({ class: "other" });
    }
    expect(classifyProviderError({ status: 400, get message() { throw new Error("must not inspect text"); } }))
      .toEqual({ class: "other", status: 400 });
  });
});

describe("sanitize", () => {
  it("a key-shaped sentinel and a key= URL in the provider message reach neither stderr nor failure.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-errors-"));
    const sentinel = `AIza${"S".repeat(35)}`;
    const providerMessage = `${sentinel} https://example.invalid/?key=${sentinel}`;
    const video = "synthetic-video";
    try {
      await writeFile(join(root, "video.mp4"), video);
      for (const phase of ["lookup", "generation", "start", "finalize"]) for (const conflict of [false, true]) {
        const output = join(root, `${phase}-${conflict}`);
        const preload = join(root, "fake-fetch.js");
        await writeFile(preload, `
          const file = { name: "files/test", uri: "https://generativelanguage.googleapis.com/v1beta/files/test", state: "ACTIVE", mimeType: "video/mp4", sizeBytes: "${video.length}", sha256Hash: "${createHash("sha256").update(video).digest("hex")}" };
          globalThis.fetch = async (input) => {
            const url = String(input instanceof Request ? input.url : input);
            const refuse = () => new Response(JSON.stringify({ error: { code: ${conflict ? 404 : 403}, message: ${JSON.stringify(providerMessage)}, status: "${conflict ? "NOT_FOUND" : "PERMISSION_DENIED"}" } }), { status: 403, headers: { "Content-Type": "application/json" } });
            if (url.includes(":generateContent")) return refuse();
            if (url.includes("/upload/")) return ${JSON.stringify(phase)} === "start" ? refuse() : new Response(null, { headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/session" } });
            if (url.endsWith("/session")) return refuse();
            if (url.includes("/files/test")) return ${JSON.stringify(phase)} === "lookup" ? refuse() : Response.json(file);
            throw new Error("Unexpected network request blocked by fixture");
          };
        `);
        const run = spawnSync("bun", ["--no-env-file", "--preload", preload, resolve("src/cli.ts"),
          "analyze", "--source", "none", "--video", join(root, "video.mp4"), "--output", output,
          "--no-derived-transcript", "--no-screenshots",
          ...(["lookup", "generation"].includes(phase) ? ["--remote-file", "files/test"] : []),
        ], { cwd: root, encoding: "utf8", timeout: 20_000,
          env: { PATH: process.env.PATH, HOME: root, GEMINI_API_KEY: "synthetic-key", TZ: "UTC" },
        });
        expect(run.status, run.stderr).toBe(1);
        expect(run.stderr).toContain(conflict ? "other provider error" : "refused");
        if (conflict) expect(run.stderr).not.toMatch(/refused|expired|key belongs/);
        expect(run.stderr).toContain("HTTP 403");
        const receipts = (await readdir(output, { recursive: true })).filter(path => path.endsWith("failure-manifest.json"));
        expect(receipts).toHaveLength(1);
        const receipt = await readFile(join(output, receipts[0]!), "utf8");
        expect(JSON.parse(receipt).error.provider).toEqual({ class: conflict ? "other" : "refused", status: 403 });
        for (const surface of [run.stdout, run.stderr, receipt]) {
          expect(surface).not.toContain(sentinel);
          expect(surface).not.toContain("key=");
          expect(surface).not.toContain("example.invalid");
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

const canonical: Record<number, string> = { 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 429: "RESOURCE_EXHAUSTED" };
const privateMessage = "synthetic-private-payload https://example.invalid/?key=synthetic";
function refusal(http: number, code = http, status = canonical[code]) {
  return Response.json({ error: { code, status, message: privateMessage } }, { status: http });
}
const file = { name: "files/test", uri: "https://generativelanguage.googleapis.com/v1beta/files/test", state: "ACTIVE", mimeType: "video/mp4" };
const recipe = { id: "synthetic", label: "Synthetic", description: "Synthetic", indexInstruction: "Index", interrogationInstruction: "Inspect" };
const meeting = { id: "synthetic", provider: "file" as const, transport: "file" as const, transcript: "", raw: {} };

describe("structured transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([[401, "refused"], [403, "refused"], [404, "not_found"], [429, "rate_limited"]])
    ("SDK HTTP %i with matching JSON is %s", async (status, classification) => {
      vi.stubGlobal("fetch", async () => refusal(Number(status)));
      const error = await new GeminiVideoAnalyzer("synthetic-key").resolveRetainedFile("files/test", "a".repeat(64), 1).catch(e => e);
      expect(error.provider).toEqual({ class: classification, status });
      expect(error.message).not.toContain(privateMessage);
    });

  it("HTTP and JSON disagreement is other at retained lookup", async () => {
    for (const [code, status] of [[404, "NOT_FOUND"], [403, "NOT_FOUND"]] as const) {
      vi.stubGlobal("fetch", async () => refusal(403, code, status));
      const error = await new GeminiVideoAnalyzer("synthetic-key").resolveRetainedFile("files/test", "a".repeat(64), 1).catch(e => e);
      expect(error.provider).toEqual({ class: "other", status: 403 });
      expect(error.message).not.toMatch(/refused|expired|key belongs|synthetic-private|key=/);
    }
  });

  it("upload start and finalize disagreements are other", async () => {
    for (const phase of ["start", "finalize"]) {
      let calls = 0;
      const uploader = createGeminiFileUploader("synthetic-key", {
        fileSize: async () => 1, openFile: () => Readable.from(["x"]),
        fetch: async () => ++calls === 1 && phase === "finalize"
          ? new Response(null, { headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/session" } })
          : refusal(403, 404),
      });
      const error = await uploader.upload("synthetic.mp4", "video/mp4").catch(e => e);
      expect(error.provider).toEqual({ class: "other", status: 403 });
      expect(error.telemetryCode).toBe("gemini_http_403");
      expect(error.message).not.toMatch(/refused|synthetic-private|key=/);
      expect(calls).toBe(phase === "start" ? 1 : 2);
    }
  });

  it("polling and generation preserve contradictory evidence without changing retries", async () => {
    vi.stubGlobal("fetch", async () => refusal(403, 404));
    const analyzer = new GeminiVideoAnalyzer("synthetic-key", "gemini-test", {
      fileUploader: { upload: async () => ({ ...file, state: "PROCESSING" }) },
      deleteFile: async () => {}, sleep: async () => {},
    });
    await expect(analyzer.upload("synthetic.mp4", "video/mp4")).rejects.toMatchObject({
      provider: { class: "other", status: 403 }, uploadCleanup: "confirmed_deleted",
    });
    for (const phase of ["index", "transcribe"]) {
      const fetch = vi.fn(async () => refusal(429, 403));
      vi.stubGlobal("fetch", fetch);
      const waits: number[] = [];
      const analyzer = new GeminiVideoAnalyzer("synthetic-key", "gemini-test", { sleep: async ms => { waits.push(ms); } });
      const result = phase === "index" ? analyzer.index(file, meeting, recipe) : analyzer.transcribe(file);
      await expect(result).rejects.toMatchObject({ provider: { class: "other", status: 429 }, telemetryCode: "gemini_http_429" });
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(waits).toEqual([1000, 2000, 4000, 8000]);
    }
  });

  it("concurrent SDK requests keep conflict evidence per response", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      await new Promise(resolve => setTimeout(resolve, String(url).includes("conflict") ? 10 : 1));
      return refusal(403, String(url).includes("conflict") ? 404 : 403);
    });
    vi.stubGlobal("fetch", fakeFetch);
    const analyzer = new GeminiVideoAnalyzer("synthetic-key");
    const results = await Promise.all(["conflict", "agree"].map(name => analyzer.resolveRetainedFile(`files/${name}`, "a".repeat(64), 1).catch(e => e)));
    expect(results.map(error => error.provider.class)).toEqual(["other", "refused"]);
    expect(globalThis.fetch).toBe(fakeFetch);
  });
});
