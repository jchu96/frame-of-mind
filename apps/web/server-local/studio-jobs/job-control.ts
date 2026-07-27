import type {
  JobCreateResult,
  JobRepository,
  LinkedRetryCreateInput,
} from "../../../../src/domain/studio-ports";
import type {
  AnalysisJob,
} from "../../../../src/domain/studio-schemas";
import {
  LocalMediaReuseGuard,
} from "./media-reuse-guard";
import {
  LocalStudioJobWorker,
} from "./local-job-worker";

export class StudioJobControlError extends Error {
  constructor(readonly code: string) {
    super("Local Studio job control failed.");
    this.name = "StudioJobControlError";
  }
}

export class LocalStudioJobControl {
  constructor(
    private readonly repository: JobRepository,
    private readonly worker: LocalStudioJobWorker,
    private readonly mediaReuse: LocalMediaReuseGuard,
  ) {}

  async requestCancellation(
    jobId: string,
    requestedAt: string,
  ): Promise<AnalysisJob> {
    const job = await this.repository.requestCancellation(jobId, requestedAt);
    this.worker.notifyCancellationPersisted(job.id);
    return job;
  }

  async createLinkedRetry(
    input: LinkedRetryCreateInput,
  ): Promise<JobCreateResult> {
    const parent = await this.repository.get(input.parentJobId);
    if (!parent) throw new StudioJobControlError("job_not_found");
    const existing = await this.repository.getByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existing) {
      return this.repository.createLinkedRetry(input);
    }
    await this.mediaReuse.assertReusable(parent, input.createdAt);
    const result = await this.repository.createLinkedRetry(input);
    this.worker.notify();
    return result;
  }
}
