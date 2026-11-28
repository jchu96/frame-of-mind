import { ContractError } from "../domain/contract-error.js";
import { AsyncLocalStorage } from "node:async_hooks";

const transfers = new AsyncLocalStorage<{started: boolean}>();

/** One command owns the history of all its uploads, including calibration and retries. */
export function withMediaTransfer<T>(work: () => Promise<T>): Promise<T> {
  const run = async () => {
    try { return await work(); }
    catch (error) {
      const details = preparationDetails();
      if (details && error instanceof Error) {
        Object.assign(error, {details:{...(error instanceof ContractError && error.details), ...details}});
      }
      throw error;
    }
  };
  return transfers.getStore() ? run() : transfers.run({started:false}, run);
}

export function preparationDetails() {
  if (transfers.getStore()?.started === false) return {phase:"prepare", sent:false} as const;
}

export function mediaRequestStarted() {
  const transfer = transfers.getStore();
  if (transfer) transfer.started = true;
}

export function uploadMedia<T>(uploader: {tracksMediaRequests?: boolean; upload(path: string, mime: string): Promise<T>},
  path: string, mime: string) {
  // An opaque transport may send bytes as soon as we call it.
  if (!uploader.tracksMediaRequests) mediaRequestStarted();
  return uploader.upload(path, mime);
}
