import {
  loadRecipe,
  UnknownBuiltInRecipeError,
} from "../../../../src/recipes/index";
import { StudioJobInputUnavailableError } from "./analysis-options";

type LoadedRecipe = Awaited<ReturnType<typeof loadRecipe>>;
type RecipeLoader = (id: string) => Promise<LoadedRecipe>;

export async function resolveComposerRecipe(
  id: string,
  loader: RecipeLoader = loadRecipe,
): Promise<LoadedRecipe> {
  try {
    return await loader(id);
  } catch (error) {
    if (error instanceof UnknownBuiltInRecipeError) {
      throw new StudioJobInputUnavailableError("recipe_not_found");
    }
    throw error;
  }
}
