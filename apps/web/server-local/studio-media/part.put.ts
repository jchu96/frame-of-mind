import {
  createError,
  defineEventHandler,
  getHeader,
  getRouterParam,
} from "h3";
import {
  MAX_MEDIA_PART_BYTES,
  supportedMediaMimeTypeSchema,
} from "../../../../src/domain/studio-schemas.js";
import { assertTrustedMutation } from "../../server/utils/request-security.js";
import { throwMediaHttpError } from "./http.js";
import { getLocalMediaStaging } from "./service.js";

function integerHeader(
  value: string | undefined,
  label: string,
): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw createError({
      statusCode: 422,
      statusMessage: `${label} must be a non-negative integer.`,
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw createError({
      statusCode: 422,
      statusMessage: `${label} is outside the supported range.`,
    });
  }
  return parsed;
}

export default defineEventHandler(async (event) => {
  assertTrustedMutation(event);
  const mimeType = supportedMediaMimeTypeSchema.safeParse(
    getHeader(event, "content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
  );
  if (!mimeType.success) {
    throw createError({
      statusCode: 415,
      statusMessage: "Content-Type must be a supported video type.",
    });
  }
  const contentLength = integerHeader(
    getHeader(event, "content-length"),
    "Content-Length",
  );
  if (contentLength <= 0 || contentLength > MAX_MEDIA_PART_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: "Media part length is outside the supported range.",
    });
  }

  try {
    const staging = await getLocalMediaStaging();
    const id = getRouterParam(event, "id") || "";
    const session = await staging.get(id);
    if (!session) {
      throw createError({
        statusCode: 404,
        statusMessage: "Media session was not found.",
      });
    }
    if (session.mimeType !== mimeType.data) {
      throw createError({
        statusCode: 415,
        statusMessage: "Content-Type does not match the media session.",
      });
    }
    return await staging.writePart(id, {
      part: integerHeader(getRouterParam(event, "part"), "Media part"),
      offset: integerHeader(getHeader(event, "upload-offset"), "Upload-Offset"),
      contentLength,
      bytes: event.node.req,
    });
  } catch (error) {
    throwMediaHttpError(error);
  }
});
