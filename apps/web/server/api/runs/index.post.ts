import { versionedRunImportSchema } from "../../../../../src/domain/schemas";
import { analysisOutcomeSchema } from "../../../../../src/domain/analysis-outcome";
import { analysisDigest } from "../../../../../src/domain/integrity";
import { readLimitedText, RequestBodyTooLargeError } from "../../utils/request-body";
import { assertTrustedJsonMutation } from "../../utils/request-security";
import { getRunStore } from "../../utils/store";
import { D1ProjectionLimitError } from "../../data/sql";
import {
  RunPrincipalConflictError,
  RunProjectionVersionConflictError,
} from "../../data/types";

const maximumImportBytes = 2 * 1024 * 1024;

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  const contentLength = Number(getHeader(event, "content-length") || 0);
  if (contentLength > maximumImportBytes) {
    throw createError({ statusCode: 413, statusMessage: "Run import exceeds 2 MiB." });
  }

  let body: unknown;
  try {
    const rawBody = await readLimitedText(getRequestWebStream(event), maximumImportBytes);
    body = JSON.parse(rawBody);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw createError({ statusCode: 413, statusMessage: "Run import exceeds 2 MiB." });
    }
    throw createError({ statusCode: 400, statusMessage: "Run import must be valid UTF-8 JSON." });
  }
  // The optional coverage outcome rides beside the strict durable pair
  // (exported review bundles include it since the outcome projection landed).
  const { outcome: rawOutcome, ...bundle } = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  const parsed = versionedRunImportSchema.safeParse(bundle);
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: "Run bundle is invalid.",
      data: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (await analysisDigest(parsed.data.analysis) !== parsed.data.manifest.analysisSha256) {
    throw createError({
      statusCode: 422,
      statusMessage: "Run bundle integrity check failed.",
    });
  }
  let outcome;
  if (rawOutcome !== undefined) {
    const parsedOutcome = analysisOutcomeSchema.safeParse(rawOutcome);
    if (!parsedOutcome.success || parsedOutcome.data.runId !== parsed.data.manifest.runId) {
      throw createError({
        statusCode: 422,
        statusMessage: "Run bundle outcome is invalid.",
      });
    }
    outcome = parsedOutcome.data;
  }

  const store = await getRunStore(event);
  let result: { runId: string; created: boolean };
  try {
    result = await store.importRun(
      outcome ? { ...parsed.data, outcome } : parsed.data,
      event.context.frameOfMindUser?.email,
    );
  } catch (error) {
    if (error instanceof D1ProjectionLimitError) {
      throw createError({ statusCode: 422, statusMessage: error.message });
    }
    if (error instanceof RunProjectionVersionConflictError) {
      throw createError({
        statusCode: 409,
        statusMessage: "Run ID already exists under another schema version.",
      });
    }
    if (error instanceof RunPrincipalConflictError) {
      throw createError({
        statusCode: 409,
        statusMessage: "Run ID is already owned by another principal.",
        data: { code: error.code },
      });
    }
    throw error;
  }
  setResponseStatus(event, result.created ? 201 : 200);
  return result;
});
