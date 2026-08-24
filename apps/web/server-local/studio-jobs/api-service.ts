import type {
  JobCreateResult,
  JobListPage,
  JobListQuery,
  JobRepository,
} from "../../../../src/domain/studio-ports";
import type {
  AnalysisJob,
  AnalysisJobEvent,
  ImmutableJobInput,
  JobCreateRequest,
} from "../../../../src/domain/studio-schemas";
import {
  verifyImmutableJobInput,
} from "../../../../src/domain/studio-schemas";

interface StudioJobControlPort {
  requestCancellation(
    jobId: string,
    requestedAt: string,
  ): Promise<AnalysisJob>;
  createLinkedRetry(input: {
    parentJobId: string;
    idempotencyKey: string;
    createdAt: string;
  }): Promise<JobCreateResult>;
}

interface StudioJobNotifier {
  notify(): void;
}

export interface RepositoryStudioJobApiOptions {
  validateInitialInput(
    input: ImmutableJobInput,
    checkedAt: string,
  ): Promise<void>;
}

export interface StudioJobDetail {
  job: AnalysisJob;
  events: AnalysisJobEvent[];
  nextAfterSequence?: number;
}

export interface StudioJobApi {
  create(input: JobCreateRequest, createdAt: string): Promise<JobCreateResult>;
  findByIdempotencyKey(idempotencyKey: string): Promise<AnalysisJob | undefined>;
  list(query: JobListQuery): Promise<JobListPage>;
  detail(
    jobId: string,
    query: { afterSequence: number; limit: number },
  ): Promise<StudioJobDetail | undefined>;
  cancel(jobId: string, requestedAt: string): Promise<AnalysisJob>;
  retry(
    jobId: string,
    input: { idempotencyKey: string },
    createdAt: string,
  ): Promise<JobCreateResult>;
}

export class StudioJobApiUnavailableError extends Error {
  constructor() {
    super("Local Studio job runtime is unavailable.");
    this.name = "StudioJobApiUnavailableError";
  }
}

export class RepositoryStudioJobApi implements StudioJobApi {
  constructor(
    private readonly repository: JobRepository,
    private readonly control: StudioJobControlPort,
    private readonly notifier: StudioJobNotifier,
    private readonly options: RepositoryStudioJobApiOptions,
  ) {}

  async create(
    input: JobCreateRequest,
    createdAt: string,
  ): Promise<JobCreateResult> {
    const verifiedInput = await verifyImmutableJobInput(input.input);
    const existing = await this.repository.getByIdempotencyKey(
      input.idempotencyKey,
    );
    if (!existing) {
      await this.options.validateInitialInput(verifiedInput.input, createdAt);
    }
    const result = await this.repository.createOrReplay({
      idempotencyKey: input.idempotencyKey,
      verifiedInput,
      createdAt,
    });
    if (result.kind === "created") this.notifier.notify();
    return result;
  }

  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<AnalysisJob | undefined> {
    return this.repository.getByIdempotencyKey(idempotencyKey);
  }

  list(query: JobListQuery): Promise<JobListPage> {
    return this.repository.list(query);
  }

  async detail(
    jobId: string,
    query: { afterSequence: number; limit: number },
  ): Promise<StudioJobDetail | undefined> {
    const job = await this.repository.get(jobId);
    if (!job) return undefined;
    const rows = await this.repository.events(
      job.id,
      query.afterSequence,
      query.limit + 1,
    );
    const events = rows.slice(0, query.limit);
    return {
      job,
      events,
      ...(rows.length > query.limit && events.length
        ? { nextAfterSequence: events.at(-1)!.sequence }
        : {}),
    };
  }

  cancel(jobId: string, requestedAt: string): Promise<AnalysisJob> {
    return this.control.requestCancellation(jobId, requestedAt);
  }

  retry(
    jobId: string,
    input: { idempotencyKey: string },
    createdAt: string,
  ): Promise<JobCreateResult> {
    return this.control.createLinkedRetry({
      parentJobId: jobId,
      idempotencyKey: input.idempotencyKey,
      createdAt,
    });
  }
}

let configuredApi: StudioJobApi | undefined;

export function configureStudioJobApi(api: StudioJobApi): void {
  if (configuredApi && configuredApi !== api) {
    throw new Error("Local Studio job API is already configured.");
  }
  configuredApi = api;
}

export function clearStudioJobApi(api: StudioJobApi): void {
  if (configuredApi === api) configuredApi = undefined;
}

export function getStudioJobApi(): StudioJobApi {
  if (!configuredApi) throw new StudioJobApiUnavailableError();
  return configuredApi;
}

export function resetStudioJobApiForTests(): void {
  configuredApi = undefined;
}
