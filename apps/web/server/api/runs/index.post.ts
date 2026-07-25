import { runImportSchema } from "../../../../../src/domain/schemas";
import { getRunStore } from "../../utils/store";

const maximumImportBytes = 2 * 1024 * 1024;

export default defineEventHandler(async (event) => {
  const contentLength = Number(getHeader(event, "content-length") || 0);
  if (contentLength > maximumImportBytes) {
    throw createError({ statusCode: 413, statusMessage: "Run import exceeds 2 MiB." });
  }

  const body = await readBody(event);
  if (JSON.stringify(body).length > maximumImportBytes) {
    throw createError({ statusCode: 413, statusMessage: "Run import exceeds 2 MiB." });
  }
  const parsed = runImportSchema.safeParse(body);
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

  const store = await getRunStore(event);
  const result = await store.importRun(parsed.data, event.context.frameOfMindUser?.email);
  setResponseStatus(event, result.created ? 201 : 200);
  return result;
});
