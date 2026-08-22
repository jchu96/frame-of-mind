import { defineEventHandler } from "h3";
import { DEFAULT_GEMINI_MODEL } from "../../../../src/adapters/gemini-model.js";
import { listBuiltInRecipes, loadRecipe } from "../../../../src/recipes/index.js";
import { getHostedWorkflowExecutor } from "./executor.js";

export default defineEventHandler(async (event) => {
  getHostedWorkflowExecutor(event);
  return {
    defaultModel: DEFAULT_GEMINI_MODEL,
    recipes: await Promise.all(listBuiltInRecipes().map(async (recipe) => ({
      id: recipe.id,
      label: recipe.label,
      description: recipe.description,
      revision: (await loadRecipe(recipe.id)).revision,
    }))),
  };
});
