import { z } from "zod";
import {
  analysisJobStageSchema,
} from "../../../../src/domain/studio-schemas.js";
import type {
  JobListQuery,
} from "../../../../src/domain/studio-ports.js";

const DEFAULT_JOB_LIMIT = 25;
const MAXIMUM_JOB_LIMIT = 100;
const DEFAULT_EVENT_LIMIT = 100;
const MAXIMUM_EVENT_LIMIT = 100;

export class StudioJobQueryError extends Error {
  constructor(readonly code: string) {
    super("Local Studio job query is invalid.");
    this.name = "StudioJobQueryError";
  }
}

export function parseJobListQuery(
  query: Record<string, unknown>,
): JobListQuery {
  try {
    const limit = parseBoundedInteger(
      query.limit,
      DEFAULT_JOB_LIMIT,
      1,
      MAXIMUM_JOB_LIMIT,
    );
    const order = query.order === undefined
      ? "newest"
      : z.enum(["newest", "oldest"]).parse(single(query.order));
    const cursor = optionalSingle(query.cursor);
    const stagesValue = optionalSingle(query.stage);
    if (cursor !== undefined && cursor.length === 0) {
      throw new StudioJobQueryError("empty_cursor");
    }
    const stages = stagesValue !== undefined
      ? [...new Set(stagesValue.split(",").filter(Boolean))]
        .map((stage) => analysisJobStageSchema.parse(stage))
      : undefined;
    if (stages && (stages.length === 0 || stages.length > 4)) {
      throw new StudioJobQueryError("invalid_stage_filter");
    }
    return {
      limit,
      order,
      ...(cursor ? { cursor } : {}),
      ...(stages ? { stages } : {}),
    };
  } catch (error) {
    if (error instanceof StudioJobQueryError) throw error;
    throw new StudioJobQueryError("invalid_filter");
  }
}

export function parseJobEventQuery(
  query: Record<string, unknown>,
): { afterSequence: number; limit: number } {
  return {
    afterSequence: parseBoundedInteger(
      query.after,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    limit: parseBoundedInteger(
      query.limit,
      DEFAULT_EVENT_LIMIT,
      1,
      MAXIMUM_EVENT_LIMIT,
    ),
  };
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const raw = single(value);
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new StudioJobQueryError("invalid_integer");
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    throw new StudioJobQueryError("integer_out_of_range");
  }
  return parsed;
}

function single(value: unknown): string {
  if (typeof value !== "string") {
    throw new StudioJobQueryError("repeated_parameter");
  }
  return value;
}

function optionalSingle(value: unknown): string | undefined {
  return value === undefined ? undefined : single(value);
}
