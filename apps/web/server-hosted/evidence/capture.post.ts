import { defineEventHandler, getHeader, getQuery, getRequestWebStream, getRouterParam, setResponseStatus } from "h3";
import { z } from "zod";
import { runIdSchema } from "../../../../src/domain/schemas.js";
import { readLimitedBytes, RequestBodyTooLargeError } from "../../server/utils/request-body.js";
import { assertTrustedMutation } from "../../server/utils/request-security.js";
import { getHostedEvidenceRuntime, throwHostedEvidenceHttpError } from "./http.js";
import { HostedEvidenceError } from "./service.js";

const shaSchema = z.string().length(64).regex(/^[a-f0-9]+$/);

export default defineEventHandler(async (event) => {
  assertTrustedMutation(event);
  try {
    if (getHeader(event, "content-type") !== "image/png") {
      throw new HostedEvidenceError("hosted_capture_format_invalid");
    }
    const runId = runIdSchema.parse(getRouterParam(event, "id"));
    const timestampSeconds = z.coerce.number().finite().min(0).max(86_400)
      .parse(getQuery(event).timestampSeconds);
    const sourceManifestSha256 = shaSchema.parse(getHeader(event, "x-fom-source-manifest-sha256"));
    const sourceRecordingSha256 = shaSchema.parse(getHeader(event, "x-fom-source-recording-sha256"));
    let bytes: Uint8Array;
    try {
      bytes = await readLimitedBytes(getRequestWebStream(event), 8 * 1_024 * 1_024);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        throw new HostedEvidenceError("hosted_capture_size_invalid");
      }
      throw error;
    }
    const runtime = getHostedEvidenceRuntime(event);
    const evidence = await runtime.service.capture({
      principalSub: runtime.principalSub,
      runId,
      timestampSeconds,
      sourceManifestSha256,
      sourceRecordingSha256,
      bytes,
    });
    setResponseStatus(event, 201);
    return { evidence };
  } catch (error) {
    throwHostedEvidenceHttpError(error);
  }
});
