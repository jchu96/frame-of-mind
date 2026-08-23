import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  builtInRecipe,
  builtInRecipeRevision,
  listBuiltInRecipes,
  loadRecipe,
  renderCharterInstruction,
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

  it("compiles the issue-review charter positive-before-negative in both phases", () => {
    const recipe = builtInRecipe("issue-review");
    expect(recipe.charter).toBeDefined();
    for (const instruction of [recipe.indexInstruction, recipe.interrogationInstruction]) {
      const order = [
        instruction.indexOf("Stance:"),
        instruction.indexOf("answers only these questions"),
        instruction.search(/qualif|satisfies/),
        instruction.indexOf("detail labels"),
        instruction.indexOf("Accepted example"),
        instruction.indexOf("Rejected example"),
        instruction.search(/Reject (only clear misses|strictly)/),
        instruction.indexOf("Boundaries:"),
      ];
      expect(order.every((position) => position >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it("binds charter phases asymmetrically", () => {
    const charter = builtInRecipe("issue-review").charter!;
    const index = renderCharterInstruction(charter, "index");
    const interrogation = renderCharterInstruction(charter, "interrogation");
    expect(index).toContain("Treat acceptance loosely at this stage");
    expect(index).toContain("Reject only clear misses");
    expect(interrogation).toContain("Accept the candidate only when it satisfies");
    expect(interrogation).toContain("Reject strictly");
    for (const instruction of [index, interrogation]) {
      expect(instruction).toContain("Boundaries: Never present an inference as an observed fact.");
      expect(instruction).toContain("Actual, Expected, Impact, Affected surface");
    }
  });

  it("loads a custom charter recipe and rejects an oversized question list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-charter-"));
    try {
      const path = join(directory, "recipe.json");
      const charter = {
        stance: "You review synthetic walkthroughs for missed steps.",
        allowedQuestions: ["Which documented step was skipped?"],
        acceptance: "A moment qualifies only when a documented step is visibly skipped.",
        labelVocabulary: ["Step", "Skipped", "Impact"],
        exemplars: [{
          verdict: "accepted" as const,
          candidate: "The operator jumps from step two to step four on screen.",
          reason: "The skipped step is directly visible.",
        }],
        rejection: "Reject commentary about steps that were performed correctly.",
        boundaries: "Never invent steps that are not on screen.",
      };
      const definition = {
        id: "step-audit",
        label: "Step audit",
        description: "Find skipped documented steps.",
        charter,
        revision: "c1",
      };
      await writeFile(path, JSON.stringify(definition));
      const loaded = await loadRecipe("ignored", path);
      expect(loaded.recipe.charter).toEqual(charter);
      expect(loaded.recipe.indexInstruction).toContain("Which documented step was skipped?");
      expect(loaded.revision).toBe("c1");
      expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await loadRecipe("ignored", path)).sha256).toBe(loaded.sha256);

      await writeFile(path, JSON.stringify({
        ...definition,
        charter: {
          ...charter,
          allowedQuestions: ["q1?", "q2?", "q3?", "q4?", "q5?"],
        },
      }));
      await expect(loadRecipe("ignored", path)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("scopes the revision bump to the migrated recipe only", async () => {
    expect(builtInRecipeRevision("issue-review")).toBe("builtin-2026-08-11.1");
    expect((await loadRecipe("issue-review")).revision).toBe(builtInRecipeRevision("issue-review"));
    for (const id of ["decisions", "requirements", "action-items", "repo-plan", "communication-coaching"]) {
      expect(builtInRecipeRevision(id)).toBe("builtin-2026-07-27.1");
      expect((await loadRecipe(id)).revision).toBe(builtInRecipeRevision(id));
    }
  });

  it("applies the deep profile on top of a charter recipe without dropping the charter", async () => {
    const loaded = await loadRecipe("issue-review");
    const deep = await withAnalysisDepth(loaded, "deep");
    expect(deep.recipe.charter).toEqual(loaded.recipe.charter);
    expect(deep.recipe.indexInstruction).toContain("Stance:");
    expect(deep.recipe.indexInstruction).toContain("Deep-understanding profile:");
    expect(deep.sha256).not.toBe(loaded.sha256);
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
