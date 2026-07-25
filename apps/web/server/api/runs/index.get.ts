import { getRunStore } from "../../utils/store";

export default defineEventHandler(async (event) => {
  const store = await getRunStore(event);
  return store.listRuns();
});
