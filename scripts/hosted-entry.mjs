import nitro from "./index.mjs";

const hostedEntryMarker = "FRAME_OF_MIND_HOSTED_ENTRY_V1";
const hostedMediaPartPath = /^\/api\/hosted\/media\/[^/]+\/parts$/;

export default {
  fetch(request, env, context) {
    if (isHostedMediaPartRequest(request)) {
      return Response.json(
        { statusCode: 404, statusMessage: "Not found." },
        { status: 404 },
      );
    }
    return nitro.fetch(request, env, context);
  },
};

function isHostedMediaPartRequest(request) {
  if (request.method !== "POST") return false;
  const pathname = normalizePathname(request.url);
  return pathname !== null && hostedMediaPartPath.test(pathname);
}

function normalizePathname(value) {
  try {
    const decoded = decodeURIComponent(new URL(value).pathname);
    const collapsed = decoded.replace(/\/{2,}/g, "/");
    return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  } catch {
    return null;
  }
}

void hostedEntryMarker;
