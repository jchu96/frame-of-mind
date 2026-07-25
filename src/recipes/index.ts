import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { AnalysisRecipe, BuiltInRecipeId } from "../domain/types.js";

const recipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  indexInstruction: z.string().min(1).max(8_000),
  interrogationInstruction: z.string().min(1).max(8_000),
});

const recipes: Record<BuiltInRecipeId, AnalysisRecipe> = {
  "issue-review": {
    id: "issue-review",
    label: "Issue review",
    description: "Find visible bugs, wrong values, errors, mis-renders, and concrete workflow friction.",
    indexInstruction:
      "Find every moment plausibly worth a product or engineering issue. Require visible or spoken evidence and reject ordinary discussion. Use detail labels such as Actual, Expected, Impact, and Affected surface.",
    interrogationInstruction:
      "Decide whether the candidate is a real, supportable issue. Capture exact observed behavior, expected behavior only when established, verbatim UI text, reporter quote, and only the steps actually observed.",
  },
  decisions: {
    id: "decisions",
    label: "Decisions",
    description: "Extract decisions, rationale, alternatives, owners, and unresolved reversibility concerns.",
    indexInstruction:
      "Find moments where participants choose, approve, reject, defer, or materially narrow an option. Do not turn suggestions into decisions. Use detail labels such as Decision, Rationale, Alternatives, Owner, and Revisit trigger.",
    interrogationInstruction:
      "Accept only decisions supported by explicit language or an unmistakable commitment. Distinguish final decisions from proposals and record rationale, dissent, owner, and follow-up trigger when stated.",
  },
  requirements: {
    id: "requirements",
    label: "Requirements",
    description: "Extract user needs, constraints, acceptance criteria, edge cases, and open questions.",
    indexInstruction:
      "Find concrete needs, constraints, examples, success conditions, failure conditions, and unresolved product questions. Reject vague preferences and unsupported scope. Use detail labels such as Requirement, User, Constraint, Acceptance criteria, and Open question.",
    interrogationInstruction:
      "Turn the observed discussion into a testable requirement without inventing scope. Preserve examples, explicit exclusions, edge cases, and unresolved questions. Mark ambiguity instead of resolving it.",
  },
  "action-items": {
    id: "action-items",
    label: "Action items",
    description: "Extract explicit commitments with owners, due dates, dependencies, and completion conditions.",
    indexInstruction:
      "Find explicit commitments and assigned follow-ups. Reject ideas or generic next steps that are not owned actions. Use detail labels such as Action, Owner, Due date, Dependency, and Done when.",
    interrogationInstruction:
      "Accept only actions with an explicit commitment or assignment. Record owner and date only when stated; otherwise label them Unassigned or Not stated. Preserve dependencies and completion conditions.",
  },
  "repo-plan": {
    id: "repo-plan",
    label: "Repository change plan",
    description: "Translate grounded meeting requests into repository-oriented changes, risks, and validation.",
    indexInstruction:
      "Find requests or decisions that imply a code, documentation, data-model, test, or operational change. Reject unsupported implementation invention. Use detail labels such as Repository, Change, Affected surface, Risk, Validation, and Open question.",
    interrogationInstruction:
      "Produce a grounded implementation input, not invented code architecture. Separate what was requested from inferred implementation implications and clearly label every inference.",
  },
};

export function builtInRecipe(id: string): AnalysisRecipe {
  const recipe = recipes[id as BuiltInRecipeId];
  if (!recipe) {
    throw new Error(`Unknown recipe '${id}'. Available recipes: ${Object.keys(recipes).join(", ")}.`);
  }
  return recipe;
}

export function listBuiltInRecipes(): AnalysisRecipe[] {
  return Object.values(recipes);
}

export async function loadRecipe(id: string, recipeFile?: string): Promise<{
  recipe: AnalysisRecipe;
  custom: boolean;
}> {
  if (!recipeFile) return { recipe: builtInRecipe(id), custom: false };
  const content = await readFile(resolve(recipeFile), "utf8");
  const recipe = recipeSchema.parse(JSON.parse(content));
  return { recipe, custom: true };
}
