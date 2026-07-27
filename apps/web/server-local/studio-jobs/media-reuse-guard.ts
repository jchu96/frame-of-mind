import type {
  MediaStagingAdapter,
} from "../../../../src/domain/studio-ports";
import type {
  AnalysisJob,
  ImmutableJobInput,
  MediaSession,
} from "../../../../src/domain/studio-schemas";
import {
  validateMediaSessionTransition,
} from "../../../../src/domain/studio-state";

export class StudioMediaReuseError extends Error {
  constructor(readonly code: string) {
    super("The staged recording is not reusable for this retry.");
    this.name = "StudioMediaReuseError";
  }
}

export interface LocalMediaReuseLease {
  session: MediaSession;
  release(): Promise<void>;
}

export interface LocalExecutionMediaAdapter extends MediaStagingAdapter {
  deleteEphemeralExecutionLease(
    id: string,
    expectedSha256: string,
  ): Promise<MediaSession>;
}

export class LocalMediaReuseGuard {
  constructor(private readonly media: MediaStagingAdapter) {}

  async assertReusable(
    job: AnalysisJob,
    checkedAt: string,
  ): Promise<MediaSession> {
    const checkedAtMilliseconds = Date.parse(checkedAt);
    if (!Number.isFinite(checkedAtMilliseconds) || !checkedAt.endsWith("Z")) {
      throw new StudioMediaReuseError("invalid_check_time");
    }
    if (job.input.retention.mode !== "retained") {
      throw new StudioMediaReuseError("media_not_retained");
    }
    const session = await this.media.get(job.input.mediaSessionId);
    if (!session) throw new StudioMediaReuseError("media_not_found");
    if (
      session.id !== job.input.mediaSessionId
      || session.status !== "retained"
      || session.retention.mode !== "retained"
    ) {
      throw new StudioMediaReuseError("media_not_reusable");
    }
    if (!session.sha256 || session.sha256 !== job.input.mediaSha256) {
      throw new StudioMediaReuseError("media_digest_mismatch");
    }
    if (
      session.retention.expiresAt !== job.input.retention.expiresAt
      || Date.parse(session.retention.expiresAt) <= checkedAtMilliseconds
    ) {
      throw new StudioMediaReuseError("media_retention_expired");
    }
    return session;
  }

  async acquire(
    job: AnalysisJob,
    checkedAt: string,
  ): Promise<LocalMediaReuseLease> {
    const session = await this.assertReusable(job, checkedAt);
    let acquired: MediaSession;
    try {
      acquired = await this.media.transition(validateMediaSessionTransition({
        id: session.id,
        expected: "retained",
        next: "in_use",
      }));
    } catch {
      throw new StudioMediaReuseError("media_lease_unavailable");
    }
    if (
      acquired.id !== job.input.mediaSessionId
      || acquired.status !== "in_use"
      || acquired.sha256 !== job.input.mediaSha256
      || acquired.retention.mode !== "retained"
      || acquired.retention.expiresAt !== job.input.retention.expiresAt
    ) {
      await this.media.transition(validateMediaSessionTransition({
        id: acquired.id,
        expected: "in_use",
        next: "retained",
      })).catch(() => undefined);
      throw new StudioMediaReuseError("media_lease_invalid");
    }
    let released = false;
    return {
      session: acquired,
      release: async () => {
        if (released) return;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await this.media.transition(validateMediaSessionTransition({
              id: acquired.id,
              expected: "in_use",
              next: "retained",
            }));
            released = true;
            return;
          } catch {
            const current = await this.media.get(acquired.id)
              .catch(() => undefined);
            if (
              current?.status === "retained"
              && current.sha256 === acquired.sha256
            ) {
              released = true;
              return;
            }
          }
        }
        throw new StudioMediaReuseError("media_lease_release_failed");
      },
    };
  }
}

export class LocalInitialMediaGuard {
  constructor(private readonly media: LocalExecutionMediaAdapter) {}

  async assertUsable(
    input: ImmutableJobInput,
    checkedAt: string,
  ): Promise<void> {
    const checkedAtMilliseconds = Date.parse(checkedAt);
    if (!Number.isFinite(checkedAtMilliseconds) || !checkedAt.endsWith("Z")) {
      throw new StudioMediaReuseError("invalid_check_time");
    }
    const session = await this.media.get(input.mediaSessionId);
    if (!session) throw new StudioMediaReuseError("media_not_found");
    if (
      session.id !== input.mediaSessionId
      || session.status !== "sealed"
      || !session.sha256
      || session.sha256 !== input.mediaSha256
    ) {
      throw new StudioMediaReuseError("media_not_usable");
    }
    if (
      session.retention.mode !== input.retention.mode
      || session.retention.expiresAt !== input.retention.expiresAt
      || Date.parse(session.retention.expiresAt) <= checkedAtMilliseconds
    ) {
      throw new StudioMediaReuseError("media_retention_expired");
    }
  }

  async acquire(
    input: ImmutableJobInput,
    checkedAt: string,
  ): Promise<LocalMediaReuseLease> {
    await this.assertUsable(input, checkedAt);
    let acquired: MediaSession;
    try {
      acquired = await this.media.transition(validateMediaSessionTransition({
        id: input.mediaSessionId,
        expected: "sealed",
        next: "in_use",
      }));
    } catch {
      throw new StudioMediaReuseError("media_lease_unavailable");
    }
    if (
      acquired.id !== input.mediaSessionId
      || acquired.status !== "in_use"
      || acquired.sha256 !== input.mediaSha256
      || acquired.retention.mode !== input.retention.mode
      || acquired.retention.expiresAt !== input.retention.expiresAt
    ) {
      await releaseInitialLease(this.media, acquired).catch(() => undefined);
      throw new StudioMediaReuseError("media_lease_invalid");
    }
    let released = false;
    return {
      session: acquired,
      release: async () => {
        if (released) return;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await releaseInitialLease(this.media, acquired);
            released = true;
            return;
          } catch {
            const current = await this.media.get(acquired.id)
              .catch(() => undefined);
            const expectedStatus = acquired.retention.mode === "retained"
              ? "retained"
              : "deleted";
            if (current?.status === expectedStatus) {
              released = true;
              return;
            }
          }
        }
        throw new StudioMediaReuseError("media_lease_release_failed");
      },
    };
  }
}

async function releaseInitialLease(
  media: LocalExecutionMediaAdapter,
  session: MediaSession,
): Promise<void> {
  if (session.retention.mode === "retained") {
    await media.transition(validateMediaSessionTransition({
      id: session.id,
      expected: "in_use",
      next: "retained",
    }));
    return;
  }
  await media.deleteEphemeralExecutionLease(session.id, session.sha256!);
}
