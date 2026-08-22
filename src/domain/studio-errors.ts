export class StudioJobInputUnavailableError extends Error {
  constructor(readonly code: string) {
    super("Local Studio analysis input is unavailable.");
    this.name = "StudioJobInputUnavailableError";
  }
}
