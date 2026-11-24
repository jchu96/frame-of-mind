// Isolated child fixture: the real SDK and resumable uploader both use this
// transport. The generation stays in flight until the test kills the worker.
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init) => {
  const command = new Headers(init.headers).get("x-goog-upload-command");
  const dispatch = command === "start" ? "start" : command ? "finalize" : "generate";
  appendFileSync(process.env.JOB_FIXTURE_LOG, dispatch + "\n");
  const origin = new URL(input).origin;
  if (dispatch === "start") return new Response(null, {headers: {"x-goog-upload-url": origin + "/upload/session"}});
  if (dispatch === "finalize") {
    for await (const _chunk of init.body) { /* consume the fixture */ }
    return Response.json({file: {name: "files/fixture", uri: origin + "/v1beta/files/fixture", state: "ACTIVE"}});
  }
  process.stderr.write("fixture generation pending\n");
  return new Promise(() => { setInterval(() => {}, 60_000); });
};
