import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-hosted-entry-"));
try {
  const source = await readFile(resolve("scripts/hosted-entry.mjs"), "utf8");
  const executable = source.replace(
    'import nitro from "./index.mjs";',
    'const nitro = { fetch() { return new Response(null, { status: 204 }); } };',
  );
  if (executable === source) throw new Error("Hosted entry Nitro import was not replaceable.");
  const fixturePath = join(temporaryRoot, "hosted-entry.mjs");
  await writeFile(fixturePath, executable);
  const entry = (await import(`${pathToFileURL(fixturePath).href}?v=1`)).default as {
    fetch(request: Request, env: unknown, context: unknown): Promise<Response> | Response;
  };

  for (const path of [
    "/api/hosted/media",
    "/api/hosted/media/media_test_0001/seal",
    "/api/hosted/media/media_test_0001/parts",
  ]) {
    const request = new Request(`https://frame-of-mind.example.test${path}`, {
      method: "POST",
      body: "fixture",
    });
    const response = await entry.fetch(request, {}, {});
    if (response.status !== 204) throw new Error(`${path} did not delegate to Nitro.`);
    if (request.bodyUsed) throw new Error(`${path} was consumed by the wrapper.`);
  }

  for (const [method, path] of [
    ["GET", "/api/hosted/media/media_test_0001/parts"],
    ["POST", "/api/hosted/media/media_test_0001"],
    ["POST", "/api/hosted/media/media_test_0001/parts/extra"],
  ] as const) {
    const response = await entry.fetch(
      new Request(`https://frame-of-mind.example.test${path}`, { method }),
      {},
      {},
    );
    if (response.status !== 204) throw new Error(`${method} ${path} did not delegate to Nitro.`);
  }

  console.log("HOSTED_ENTRY_DELEGATION_CONTRACT PASSED");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
