import type { AdminAccessGroups } from "../../../../shared/admin-access";
import {
  listAdminAccess,
  requireFrameOfMindMaintainer,
} from "../../../utils/admin-access";
import { betterAuthDatabase } from "../../../utils/better-auth";

export default defineEventHandler(async (event): Promise<AdminAccessGroups> => {
  requireFrameOfMindMaintainer(event);
  const groups: AdminAccessGroups = { requested: [], approved: [], revoked: [] };
  for (const row of await listAdminAccess(betterAuthDatabase(event))) {
    groups[row.state].push(row);
  }
  return groups;
});
