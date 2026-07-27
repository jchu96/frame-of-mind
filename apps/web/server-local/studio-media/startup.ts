import { createMediaExpiryJanitor } from "./expiry-janitor.js";
import { getLocalMediaStaging } from "./service.js";

export default defineNitroPlugin(async (nitroApp) => {
  const staging = await getLocalMediaStaging();
  const janitor = createMediaExpiryJanitor(staging, {
    onError: (failure) => {
      console.error(
        "Local Studio media expiry sweep failed.",
        { code: failure.code, count: failure.count },
      );
    },
  });
  nitroApp.hooks.hook("close", () => janitor.stop());
});
