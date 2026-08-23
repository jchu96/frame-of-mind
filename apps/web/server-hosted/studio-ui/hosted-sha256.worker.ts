import { hashBlobIncrementally } from "./hosted-sha256.js";

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  try {
    const file = event.data.file;
    const sha256 = await hashBlobIncrementally(file, (bytes) => {
      self.postMessage({ type: "progress", bytes, total: file.size });
    });
    self.postMessage({ type: "complete", sha256 });
  } catch {
    self.postMessage({ type: "error", code: "hosted_media_hash_failed" });
  }
};
