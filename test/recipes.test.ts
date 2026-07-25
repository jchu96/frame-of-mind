import { describe, expect, it } from "vitest";
import { builtInRecipe, listBuiltInRecipes } from "../src/recipes/index.js";

describe("analysis recipes", () => {
  it("publishes stable built-in recipe identifiers", () => {
    expect(listBuiltInRecipes().map((recipe) => recipe.id)).toEqual([
      "issue-review",
      "decisions",
      "requirements",
      "action-items",
      "repo-plan",
    ]);
  });

  it("gives every recipe explicit inclusion and rejection guidance", () => {
    for (const recipe of listBuiltInRecipes()) {
      expect(recipe.indexInstruction.toLowerCase()).toContain("find");
      expect(recipe.indexInstruction.toLowerCase()).toContain("reject");
      expect(recipe.interrogationInstruction.length).toBeGreaterThan(50);
    }
  });

  it("fails closed for an unknown recipe", () => {
    expect(() => builtInRecipe("summarize-everything")).toThrow(/Unknown recipe/);
  });
});
