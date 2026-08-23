import { defineEventHandler } from "h3";
import { DEFAULT_GEMINI_MODEL } from "../../../../src/adapters/gemini-model.js";
import {
  builtInRecipeRevision,
  listBuiltInRecipes,
} from "../../../../src/recipes/index.js";
import { getHostedWorkflowExecutor } from "./executor.js";

export default defineEventHandler(async (event) => {
  getHostedWorkflowExecutor(event);
  return {
    defaultModel: DEFAULT_GEMINI_MODEL,
    recipes: listBuiltInRecipes().map((recipe) => ({
      id: recipe.id,
      label: recipe.label,
      description: recipe.description,
      revision: builtInRecipeRevision(recipe.id),
    })),
  };
});
