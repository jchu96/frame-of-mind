import type { MediaSession } from "../../../../src/domain/studio-schemas";

export class StudioMediaCleanupRetryError extends Error {
  constructor(readonly code: string) {
    super("Local Studio media cleanup retry failed.");
    this.name = "StudioMediaCleanupRetryError";
  }
}

export interface MediaCleanupRetryAdapter {
  get(id: string): Promise<MediaSession | undefined>;
  delete(id: string): Promise<MediaSession>;
}

export async function retryFailedMediaCleanup(
  media: MediaCleanupRetryAdapter,
  id: string,
): Promise<MediaSession> {
  const session = await media.get(id);
  if (!session) throw new StudioMediaCleanupRetryError("media_not_found");
  if (session.status !== "cleanup_failed") {
    throw new StudioMediaCleanupRetryError("media_cleanup_not_retryable");
  }
  return media.delete(session.id);
}
