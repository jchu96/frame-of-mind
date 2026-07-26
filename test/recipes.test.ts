import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { builtInRecipe, listBuiltInRecipes, loadRecipe } from "../src/recipes/index.js";

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

  it("rejects unknown custom fields and records exact recipe provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-recipe-"));
    try {
      const path = join(directory, "recipe.json");
      const recipe = {
        id: "custom-review",
        label: "Custom review",
        description: "Find a narrow class of grounded observations.",
        indexInstruction: "Find supported examples and reject unsupported examples.",
        interrogationInstruction: "Accept only observations with direct visual or spoken evidence.",
        revision: "r1",
      };
      await writeFile(path, JSON.stringify(recipe));
      const loaded = await loadRecipe("ignored", path);
      expect(loaded.revision).toBe("r1");
      expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/);
      await writeFile(path, JSON.stringify({ ...recipe, unsafeOverride: true }));
      await expect(loadRecipe("ignored", path)).rejects.toThrow(/unrecognized/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
