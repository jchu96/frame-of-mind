import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGeminiFileUploader } from "../src/adapters/gemini-files.js";
import { calibrateClipClock } from "../src/adapters/gemini-calibration.js";

// Files API 403 envelope: googleapis/googleapis google/rpc/code.proto and
// googleapis/js-genai src/_api_client.ts. The transport may refuse before
// consuming its body; the fake deliberately leaves a real file open pending.
describe("calibration upload lifetime", () => {
  it("immediate refusal settles a pending file open before scratch deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-upload-lifetime-"));
    try {
      for (const thrown of [false, true]) {
        let path = ""; let calls = 0; let closed = false; let existedAtClose = false;
        const uploader = createGeminiFileUploader("synthetic-key", {
          openFile: filename => {
            path = filename;
            const stream = createReadStream(filename);
            stream.once("close", () => { closed = true; });
            // A real pending open exercises the file-descriptor lifecycle.
            return stream;
          },
          fetch: async () => {
            if (++calls === 1) return new Response(null, { headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/session" } });
            if (thrown) throw { status: 403 };
            return Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "synthetic refusal" } }, { status: 403 });
          },
        });
        const result = await calibrateClipClock({ model: "gemini-test",
          upload: async (...args) => {
            try { return await uploader.upload(...args); }
            finally {
              existedAtClose = closed && (await stat(path)).isFile();
            }
          },
          probeClipClock: async () => { throw new Error("must not probe a refused upload"); },
          delete: async () => { throw new Error("no remote identity obtained"); },
        }, { cacheRoot: root, force: true, synthesize: async filename => { await writeFile(filename, "synthetic-video"); return true; } });
        expect(closed).toBe(true);
        expect(existedAtClose).toBe(true);
        expect(result.result).toBe("unverified");
        expect(calls).toBe(2);
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
