import { getLocalMediaStaging } from "./service.js";

export default defineNitroPlugin(async () => {
  await getLocalMediaStaging();
});
