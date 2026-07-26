import { defineEventHandler } from "h3";
import { getStudioConnectionService } from "./connections.js";

export default defineEventHandler(() => getStudioConnectionService().status());
