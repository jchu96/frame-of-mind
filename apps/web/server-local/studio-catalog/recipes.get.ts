import { defineEventHandler } from "h3";
import { studioRecipeCatalog } from "./recipes.js";

export default defineEventHandler(async () => studioRecipeCatalog());
