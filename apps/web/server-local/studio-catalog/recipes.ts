import { DEFAULT_GEMINI_MODEL } from "../../../../src/adapters/gemini.js";
import {
  listBuiltInRecipes,
  loadRecipe,
} from "../../../../src/recipes/index.js";

export interface StudioRecipeSummary {
  id: string;
  label: string;
  description: string;
  revision: string;
}

export async function studioRecipeCatalog(): Promise<{
  defaultModel: string;
  recipes: StudioRecipeSummary[];
}> {
  const recipes = await Promise.all(listBuiltInRecipes().map(async (recipe) => {
    const loaded = await loadRecipe(recipe.id);
    return {
      id: recipe.id,
      label: recipe.label,
      description: recipe.description,
      revision: loaded.revision,
    };
  }));
  return { defaultModel: DEFAULT_GEMINI_MODEL, recipes };
}
