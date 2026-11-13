export interface RunNote {
  name: string;
  text: string;
  sha256: string;
  bytes: number;
}
export const RUN_NOTE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_RUN_NOTES = 8;
export const MAX_RUN_NOTE_BYTES = 64 * 1024;
