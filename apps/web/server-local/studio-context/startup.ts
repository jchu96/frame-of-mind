import { createContextExpiryJanitor } from "./expiry-janitor.js";
import { getLocalContextFileStaging } from "./service.js";

export default defineNitroPlugin(async (nitroApp) => {
  const staging = await getLocalContextFileStaging();
  const janitor = createContextExpiryJanitor(staging, {
    onError: (code) => {
      console.error("Local Studio context expiry sweep failed.", { code });
    },
  });
  nitroApp.hooks.hook("close", () => janitor.stop());
});
