import { defineEventHandler, getRouterParam } from "h3";
import { getStudioReviewMedia } from "./review-service.js";

export default defineEventHandler(async (event) => ({
  available: await getStudioReviewMedia().available(
    getRouterParam(event, "id") ?? "",
  ),
}));
