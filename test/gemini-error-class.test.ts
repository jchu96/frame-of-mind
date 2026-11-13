import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../src/adapters/gemini-error-class.js";

// SDK shape: https://googleapis.github.io/js-genai/release_docs/classes/errors.ApiError.html
// Status meanings from https://ai.google.dev/gemini-api/docs/troubleshooting
// and its linked https://ai.google.dev/gemini-api/docs/api-errors reference:
// 401 authentication, 403 permission_denied, 404 not_found, 429 rate/quota limit.
describe("classify", () => {
  it.each([[401, "refused"], [403, "refused"], [404, "not_found"], [429, "rate_limited"], [400, "other"], [503, "other"]] as const)
    ("%i is %s", (status, classification) => {
      expect(classifyProviderError(new ApiError({ status, message: "synthetic error" })))
        .toEqual({ class: classification, status });
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
      for (const phase of ["lookup", "generation", "start", "finalize"]) {
        const output = join(root, phase);
        const preload = join(root, "fake-fetch.js");
        await writeFile(preload, `
          const file = { name: "files/test", uri: "https://generativelanguage.googleapis.com/v1beta/files/test", state: "ACTIVE", mimeType: "video/mp4", sizeBytes: "${video.length}", sha256Hash: "${createHash("sha256").update(video).digest("hex")}" };
          globalThis.fetch = async (input) => {
            const url = String(input instanceof Request ? input.url : input);
            const refuse = () => new Response(JSON.stringify({ error: { code: 403, message: ${JSON.stringify(providerMessage)}, status: "PERMISSION_DENIED" } }), { status: 403, headers: { "Content-Type": "application/json" } });
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
        expect(run.stderr).toContain("refused");
        expect(run.stderr).toContain("HTTP 403");
        const receipts = (await readdir(output, { recursive: true })).filter(path => path.endsWith("failure-manifest.json"));
        expect(receipts).toHaveLength(1);
        const receipt = await readFile(join(output, receipts[0]!), "utf8");
        expect(JSON.parse(receipt).error.provider).toEqual({ class: "refused", status: 403 });
        for (const surface of [run.stdout, run.stderr, receipt]) {
          expect(surface).not.toContain(sentinel);
          expect(surface).not.toContain("key=");
          expect(surface).not.toContain("example.invalid");
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
