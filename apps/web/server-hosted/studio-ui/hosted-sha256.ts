import { createSHA256 } from "hash-wasm";

export const HOSTED_HASH_SLICE_BYTES = 2 * 1_024 * 1_024;

export async function hashBlobIncrementally(
  blob: Blob,
  onProgress: (bytes: number) => void = () => undefined,
): Promise<string> {
  const hash = await createSHA256();
  hash.init();
  for (let offset = 0; offset < blob.size; offset += HOSTED_HASH_SLICE_BYTES) {
    const end = Math.min(offset + HOSTED_HASH_SLICE_BYTES, blob.size);
    hash.update(new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
    onProgress(end);
  }
  return hash.digest("hex");
}
