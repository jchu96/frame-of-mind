import nitro from "./index.mjs";

const hostedEntryMarker = "FRAME_OF_MIND_HOSTED_ENTRY_V2_DELEGATING";

export default {
  fetch(request, env, context) {
    return nitro.fetch(request, env, context);
  },
};

void hostedEntryMarker;
