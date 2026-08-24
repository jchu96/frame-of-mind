import { readAdminAccessAction } from "../../../utils/admin-access";

export default defineEventHandler(async (event) => {
  return await readAdminAccessAction(event, "revoke");
});
