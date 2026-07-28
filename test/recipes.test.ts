import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  builtInRecipe,
  listBuiltInRecipes,
  loadRecipe,
  withAnalysisDepth,
} from "../src/recipes/index.js";

describe("analysis recipes", () => {
  it("publishes stable built-in recipe identifiers", () => {
    expect(listBuiltInRecipes().map((recipe) => recipe.id)).toEqual([
      "issue-review",
      "decisions",
      "requirements",
      "action-items",
      "repo-plan",
      "communication-coaching",
    ]);
  });

  it("scopes communication coaching to observable behavior in the recording", () => {
    const recipe = builtInRecipe("communication-coaching");

    expect(recipe.indexInstruction).toContain("observable communication");
    expect(recipe.interrogationInstruction).toContain("in this recording");
    expect(recipe.interrogationInstruction).toContain("Do not diagnose");
    expect(recipe.interrogationInstruction).toContain("Infer likely intent");
    expect(recipe.interrogationInstruction).toContain("rather than an observed fact");
    expect(recipe.interrogationInstruction).toContain("Guidance");
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

  it("versions and hashes the effective deep-understanding recipe", async () => {
    const loaded = await loadRecipe("requirements");
    const standard = await withAnalysisDepth(loaded, "standard");
    const deep = await withAnalysisDepth(loaded, "deep");

    expect(standard).toEqual({ ...loaded, depth: "standard", indexFps: 0.5 });
    expect(deep.recipe.id).toBe(loaded.recipe.id);
    expect(deep.recipe.label).toBe(loaded.recipe.label);
    expect(deep.sha256).not.toBe(loaded.sha256);
    expect(deep.revision).toContain("deep-understanding-v1");
    expect(deep.indexFps).toBe(1);
    expect(deep.recipe.indexInstruction).toContain("direct audio and visual observations");
    expect(deep.recipe.interrogationInstruction).toContain("Label every inference");
    expect(deep.recipe.interrogationInstruction).toContain("verification");
  });

  it("keeps deep provenance bounded when a custom revision uses its full limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-deep-recipe-"));
    try {
      const path = join(directory, "recipe.json");
      await writeFile(path, JSON.stringify({
        id: "bounded-deep",
        label: "Bounded deep",
        description: "Exercise bounded deep provenance.",
        indexInstruction: "Find supported examples and reject unsupported examples.",
        interrogationInstruction: "Accept only observations with direct evidence.",
        revision: "r".repeat(120),
      }));

      const deep = await withAnalysisDepth(await loadRecipe("ignored", path), "deep");
      expect(deep.revision.length).toBeLessThanOrEqual(120);
      expect(deep.revision).toContain("deep-understanding-v1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
