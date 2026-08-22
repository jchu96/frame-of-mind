import {
  createError,
  defineEventHandler,
  getRouterParam,
  setResponseHeader,
} from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import type {
  AnalysisJob,
  AnalysisJobEvent,
} from "../../../../src/domain/studio-schemas.js";
import { getStudioJobApi } from "../studio-jobs/api-service.js";
import { throwJobHttpError } from "../studio-jobs/http.js";
import { getLocalMediaStaging } from "../studio-media/service.js";
import {
  buildActivityTechnicalDetails,
  formatActivitySupportReceipt,
} from "./activity-support-receipt.js";

const JOB_EVENT_PAGE_SIZE = 100;
const MAX_JOB_EVENT_PAGES = 20;

export default defineEventHandler(async (event) => {
  try {
    const id = parseOpaqueResourceId(getRouterParam(event, "id"));
    const events: AnalysisJobEvent[] = [];
    let afterSequence = 0;
    let job: AnalysisJob | undefined;

    for (let page = 0; page < MAX_JOB_EVENT_PAGES; page += 1) {
      const detail = await getStudioJobApi().detail(id, {
        afterSequence,
        limit: JOB_EVENT_PAGE_SIZE,
      });
      if (!detail) {
        throw createError({
          statusCode: 404,
          statusMessage: "Analysis job was not found.",
        });
      }
      job = detail.job;
      events.push(...detail.events);
      if (detail.nextAfterSequence === undefined) break;
      if (detail.nextAfterSequence <= afterSequence) {
        throw createError({
          statusCode: 500,
          statusMessage: "Support receipt pagination did not advance.",
        });
      }
      afterSequence = detail.nextAfterSequence;
      if (page === MAX_JOB_EVENT_PAGES - 1) {
        throw createError({
          statusCode: 500,
          statusMessage: "Support receipt exceeded the event limit.",
        });
      }
    }

    if (!job) {
      throw createError({
        statusCode: 404,
        statusMessage: "Analysis job was not found.",
      });
    }
    const media = await (await getLocalMediaStaging()).get(
      job.input.mediaSessionId,
    );
    const receipt = formatActivitySupportReceipt(
      buildActivityTechnicalDetails({ job, events, media: media ?? null }),
    );
    setResponseHeader(event, "content-type", "text/plain; charset=utf-8");
    setResponseHeader(event, "cache-control", "no-store");
    return receipt;
  } catch (error) {
    throwJobHttpError(error);
  }
});
