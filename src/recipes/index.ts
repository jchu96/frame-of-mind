import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { AnalysisRecipe, BuiltInRecipeId, RecipeCharter } from "../domain/types.js";
import { sha256Utf8 } from "../domain/integrity.js";

const instructionRecipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  indexInstruction: z.string().min(1).max(8_000),
  interrogationInstruction: z.string().min(1).max(8_000),
  revision: z.string().min(1).max(120).optional(),
}).strict();

const exemplarSchema = z.object({
  verdict: z.enum(["accepted", "rejected"]),
  candidate: z.string().min(1).max(500),
  reason: z.string().min(1).max(500),
}).strict();

const charterSchema = z.object({
  stance: z.string().min(1).max(500),
  allowedQuestions: z.array(z.string().min(1).max(300)).min(1).max(4),
  acceptance: z.string().min(1).max(1_000),
  labelVocabulary: z.array(z.string().min(1).max(80)).min(1).max(12),
  exemplars: z.array(exemplarSchema).min(1).max(2),
  rejection: z.string().min(1).max(1_000),
  boundaries: z.string().min(1).max(1_000),
  phaseFocus: z.object({
    index: z.string().min(1).max(1_500).optional(),
    interrogation: z.string().min(1).max(1_500).optional(),
  }).strict().optional(),
}).strict();

const charterRecipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  charter: charterSchema,
  revision: z.string().min(1).max(120).optional(),
}).strict();

const recipeFileSchema = z.union([charterRecipeSchema, instructionRecipeSchema]);

export const analysisDepthSchema = z.enum(["standard", "deep"]);
export type AnalysisDepth = z.infer<typeof analysisDepthSchema>;

const DEEP_INDEX_INSTRUCTION = [
  "Deep-understanding profile:",
  "First identify direct audio and visual observations, then identify the intent, constraint, alternative, exception, consequence, or uncertainty they support.",
  "Include adjacent moments that materially clarify or contradict the apparent request; do not isolate a quote from its resolution.",
  "Prefer precise timestamps and small coherent windows. Keep observation distinct from interpretation and never promote a plausible implication to a stated fact.",
].join(" ");

const DEEP_INTERROGATION_INSTRUCTION = [
  "Analyze the candidate in layers: directly observed audio/visual evidence; supported meaning or intent; plausible implications; counterevidence or alternatives; and what still requires verification.",
  "Label every inference as Inference and state its observed basis. Use labels such as Observed state, Direct request, Interpretation, Inference, Alternative, Uncertainty, and Verification needed when applicable.",
  "Do not expose hidden reasoning or invent off-screen state; return only concise conclusions and evidence through the structured fields.",
].join(" ");

function renderExemplars(charter: RecipeCharter): string {
  return charter.exemplars
    .map((exemplar) =>
      `${exemplar.verdict === "accepted" ? "Accepted" : "Rejected"} example — candidate: ${exemplar.candidate} Why: ${exemplar.reason}`
    )
    .join("\n");
}

// Slots render positive-before-negative in the ADR 0016 fixed order. The
// passes bind asymmetrically: acceptance is loose at index (candidate-worthy)
// and strict at interrogation; rejection binds strictly only at
// interrogation; boundaries bind both without qualification.
export function renderCharterInstruction(
  charter: RecipeCharter,
  phase: "index" | "interrogation",
): string {
  if (phase === "index") {
    return [
      `Stance: ${charter.stance}`,
      `This recipe answers only these questions: ${charter.allowedQuestions.join(" ")}`,
      ...(charter.phaseFocus?.index ? [charter.phaseFocus.index] : []),
      `Find every moment that could plausibly qualify: ${charter.acceptance} Treat acceptance loosely at this stage; final acceptance happens during interrogation.`,
      `Use detail labels such as ${charter.labelVocabulary.join(", ")}.`,
      renderExemplars(charter),
      `Reject only clear misses: ${charter.rejection}`,
      `Boundaries: ${charter.boundaries}`,
    ].join("\n");
  }
  return [
    `Stance: ${charter.stance}`,
    `This recipe answers only these questions: ${charter.allowedQuestions.join(" ")}`,
    ...(charter.phaseFocus?.interrogation ? [charter.phaseFocus.interrogation] : []),
    `Accept the candidate only when it satisfies: ${charter.acceptance}`,
    `Use detail labels from this vocabulary: ${charter.labelVocabulary.join(", ")}.`,
    renderExemplars(charter),
    `Reject strictly: ${charter.rejection}`,
    `Boundaries: ${charter.boundaries}`,
  ].join("\n");
}

const MAX_INSTRUCTION_LENGTH = 8_000;

function compileCharterRecipe(
  parsed: z.infer<typeof charterRecipeSchema>,
): AnalysisRecipe {
  const indexInstruction = renderCharterInstruction(parsed.charter, "index");
  const interrogationInstruction = renderCharterInstruction(parsed.charter, "interrogation");
  if (
    indexInstruction.length > MAX_INSTRUCTION_LENGTH
    || interrogationInstruction.length > MAX_INSTRUCTION_LENGTH
  ) {
    throw new Error(
      `Recipe '${parsed.id}' renders past the ${MAX_INSTRUCTION_LENGTH}-character instruction limit; shorten its charter slots.`,
    );
  }
  return {
    id: parsed.id,
    label: parsed.label,
    description: parsed.description,
    indexInstruction,
    interrogationInstruction,
    ...(parsed.revision ? { revision: parsed.revision } : {}),
    charter: parsed.charter,
  };
}

const issueReviewCharter: RecipeCharter = {
  stance:
    "You are a meticulous QA reviewer looking for defects and friction a product or engineering team should act on.",
  allowedQuestions: [
    "What visibly went wrong, rendered incorrectly, or showed a wrong value or error?",
    "Where does observed behavior contradict an expectation the recording itself establishes?",
    "What concrete workflow friction did a participant encounter?",
  ],
  acceptance:
    "A moment qualifies only with visible or spoken evidence of a bug, wrong value, error, mis-render, or concrete workflow friction.",
  labelVocabulary: ["Actual", "Expected", "Impact", "Affected surface"],
  exemplars: [
    {
      verdict: "accepted",
      candidate:
        "A save control stays disabled after every required field is filled and the reporter says it will not let them save.",
      reason:
        "Visible control state plus the reporter's statement establish actual behavior, expectation, and impact.",
    },
    {
      verdict: "rejected",
      candidate:
        "Participants discuss whether a future export option might be useful.",
      reason:
        "Ordinary product discussion with no observed defect, wrong value, or friction.",
    },
  ],
  rejection:
    "Reject ordinary discussion, speculation about unobserved behavior, and expectations nobody established.",
  boundaries:
    "Never present an inference as an observed fact. Never invent reproduction steps, URLs, or off-screen state. Record only steps actually observed.",
};

// Instructional and explainer videos: the free-prose custom recipe this
// replaces let the model coin its own detail labels, so one concept came back
// under several spellings across records. The interrogation focus therefore
// fixes each label's exact spelling and meaning.
const teachingPointsCharter: RecipeCharter = {
  stance:
    "You are a careful note-taker watching an instructional or explainer video, recording exactly what it teaches so that someone who has not seen it can rely on the notes.",
  allowedQuestions: [
    "What rule, recommendation, explanation, term, or number does the video state?",
    "What does each diagram, animation, or demonstration show, and does the picture show something the words do not?",
    "What reason does the video itself give for each point?",
    "Which claims depend on the maker's own product rather than holding generally?",
  ],
  acceptance:
    "A moment qualifies when it teaches one concrete point: a stated rule or recommendation, an explanation of a cause, a named term, a number with its unit, or a diagram, animation, or demonstration that conveys content.",
  labelVocabulary: [
    "Teaching point",
    "Narrator's words",
    "Numbers",
    "Reason given",
    "On screen",
    "Picture says more than words",
    "Maker-specific",
  ],
  exemplars: [
    {
      verdict: "accepted",
      candidate:
        "An animation shows a pipe narrowing while its arrows speed up, and the narrator says water moves faster through the narrow section.",
      reason:
        "One distinct explanation, both said and shown; the arrows go under On screen and nothing is added beyond what the video states.",
    },
    {
      verdict: "rejected",
      candidate:
        "The presenter thanks viewers on camera and asks them to subscribe while the channel logo animates.",
      reason: "Branding and a call to subscribe teach nothing.",
    },
  ],
  rejection:
    "Reject title cards, intros and outros, branding, sponsor or product promotion that teaches nothing, and calls to subscribe, like, or comment. Reject talk that only restates a point already made over the same picture.",
  boundaries:
    "Record only what the video states or shows. Never add domain knowledge, corrections, numbers, or reasons the video does not give, even when they are well known. Keep the narrator's words verbatim. Never present a claim about the maker's own product as a general rule.",
  phaseFocus: {
    index:
      "Index each new diagram or animation state that shows something new as its own candidate, even within one sequence, so each state keeps its own picture. Merge only when the same point is told over the same unchanged picture; do not split that into candidates seconds apart.",
    interrogation: [
      "Write details with these labels exactly as spelled, each at most once; omit a label that does not apply rather than writing None.",
      "Teaching point: the point in one plain sentence.",
      "Narrator's words: the exact spoken words.",
      "Numbers: every number with its unit, as said or shown.",
      "Reason given: the video's own reason, only if it gives one.",
      "On screen: what is drawn or shown, where things are, what moves or changes.",
      "Picture says more than words: only when the picture shows something the words do not.",
      "Maker-specific: only when a claim depends on the maker's own product.",
      "This is not a software screen: omit where and evidence.verbatimUiText, and put on-screen text under On screen.",
      "Set evidence.timestamp where the picture that carries the point is fully on screen and settled, not mid-transition.",
    ].join(" "),
  },
};

const recipes: Record<BuiltInRecipeId, AnalysisRecipe> = {
  // Per-recipe revision: only issue-review changed content in the charter
  // migration. The five untouched recipes keep the historical fallback so
  // Studio's immutable recipe receipts (sha256 + revision) stay valid for
  // jobs queued before this release.
  "issue-review": compileCharterRecipe({
    id: "issue-review",
    label: "Issue review",
    description: "Find visible bugs, wrong values, errors, mis-renders, and concrete workflow friction.",
    charter: issueReviewCharter,
    revision: "builtin-2026-08-11.1",
  }),
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
  "communication-coaching": {
    id: "communication-coaching",
    label: "Communication coaching",
    description:
      "Analyze observable communication and teaching patterns in this recording and produce respectful, evidence-backed guidance.",
    indexInstruction:
      "Find representative moments of observable communication: explanation structure, questioning, examples, pacing, emphasis, turn-taking, response to confusion, and repair or reframing. Include counterexamples and learner or audience signals when visible or audible. Find missed questions, objections, openings, or response cues when supported by the interaction; reject personality diagnoses and unsupported claims about aptitude, mental state, or sensitive traits.",
    interrogationInstruction:
      "Scope every pattern to behavior observable in this recording. Separate Observation, Stated goal, Interpreted intent, Likely effect, Missed cue, Alternative interpretation, Guidance, and Suggested practice. Infer likely intent only when useful, cite its observed basis, label it as interpretation rather than an observed fact, and include a plausible alternative. Compare stated intent with observable audience response when context supplies the speaker's goal. Preserve strengths as well as growth opportunities, cite exact spoken or visible evidence, and make advice conditional on the audience and goal. Do not diagnose personality, aptitude, mental health, or protected or sensitive traits, and do not generalize one recording into a stable judgment about the person.",
  },
  // Explainer videos are where mid-transition screenshots were seen and where
  // the settled-frame search was checked; no other recipe uses it yet.
  "teaching-points": {
    ...compileCharterRecipe({
      id: "teaching-points",
      label: "Teaching points",
      description:
        "Extract each distinct rule, explanation, term, number, diagram, or demonstration an instructional video teaches, with what the picture shows.",
      charter: teachingPointsCharter,
      revision: "builtin-2026-11-22.1",
    }),
    screenshotStrategy: "settled",
  },
};

const DEFAULT_BUILT_IN_RECIPE_REVISION = "builtin-2026-07-27.1";

export class UnknownBuiltInRecipeError extends Error {
  constructor(readonly recipeId: string, availableIds: readonly string[]) {
    super(`Unknown recipe '${recipeId}'. Available recipes: ${availableIds.join(", ")}.`);
    this.name = "UnknownBuiltInRecipeError";
  }
}

export function builtInRecipe(id: string): AnalysisRecipe {
  const recipe = recipes[id as BuiltInRecipeId];
  if (!recipe) {
    throw new UnknownBuiltInRecipeError(id, Object.keys(recipes));
  }
  return recipe;
}

export function listBuiltInRecipes(): AnalysisRecipe[] {
  return Object.values(recipes);
}

export function builtInRecipeRevision(id: string): string {
  return builtInRecipe(id).revision ?? DEFAULT_BUILT_IN_RECIPE_REVISION;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value;
}

export function digestRecipe(recipe: AnalysisRecipe): Promise<string> {
  // A charter recipe digests its full nested source; the historical shallow
  // replacer is preserved for instruction recipes so their hashes are stable.
  const canonical = recipe.charter
    ? JSON.stringify(canonicalize(recipe))
    : JSON.stringify(recipe, Object.keys(recipe).sort());
  return sha256Utf8(canonical);
}

export async function loadRecipe(id: string, recipeFile?: string): Promise<{
  recipe: AnalysisRecipe;
  custom: boolean;
  sha256: string;
  revision: string;
}> {
  let recipe: AnalysisRecipe;
  if (recipeFile) {
    const parsed = recipeFileSchema.parse(
      JSON.parse(await readFile(resolve(recipeFile), "utf8")),
    );
    recipe = "charter" in parsed ? compileCharterRecipe(parsed) : parsed;
  } else {
    recipe = builtInRecipe(id);
  }
  return {
    recipe,
    custom: Boolean(recipeFile),
    sha256: await digestRecipe(recipe),
    revision: recipeFile ? recipe.revision || "content-addressed" : builtInRecipeRevision(id),
  };
}

export async function withAnalysisDepth(
  loaded: Awaited<ReturnType<typeof loadRecipe>>,
  depth: AnalysisDepth,
): Promise<Awaited<ReturnType<typeof loadRecipe>> & {
  depth: AnalysisDepth;
  indexFps: number;
}> {
  const validatedDepth = analysisDepthSchema.parse(depth);
  if (validatedDepth === "standard") {
    return { ...loaded, depth: validatedDepth, indexFps: 0.5 };
  }
  const recipe: AnalysisRecipe = {
    ...loaded.recipe,
    indexInstruction: `${loaded.recipe.indexInstruction}\n\n${DEEP_INDEX_INSTRUCTION}`,
    interrogationInstruction:
      `${loaded.recipe.interrogationInstruction}\n\n${DEEP_INTERROGATION_INSTRUCTION}`,
  };
  return {
    ...loaded,
    recipe,
    sha256: await digestRecipe(recipe),
    revision: `deep-understanding-v1-${loaded.sha256.slice(0, 12)}`,
    depth: validatedDepth,
    indexFps: 1,
  };
}
