import { z } from "zod";
import {
  composerRecipeSchema,
  customRecipeSchema,
} from "../../../../src/domain/studio-schemas";

export const INTENT_DRAFT_STORAGE_KEY =
  "frame-of-mind:studio:intent-draft";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const intentDraftSchema = z.object({
  recipe: composerRecipeSchema,
  focus: z.string().max(10_000).optional(),
  model: z.string().min(1).max(240),
}).strict();

export type IntentDraft = z.infer<typeof intentDraftSchema>;
export type CustomRecipe = z.infer<typeof customRecipeSchema>;

export type IntentValidation =
  | { ok: true; draft: IntentDraft }
  | { ok: false; fieldErrors: Record<string, string> };

function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const root = String(issue.path[0] ?? "intent");
    const field = root === "recipe" ? "customRecipe" : root;
    errors[field] ??= issue.message;
  }
  return errors;
}

export function validateIntentDraft(input: unknown): IntentValidation {
  const parsed = intentDraftSchema.safeParse(input);
  return parsed.success
    ? { ok: true, draft: parsed.data }
    : { ok: false, fieldErrors: fieldErrors(parsed.error) };
}

export function parseCustomRecipeImport(value: string):
  | { ok: true; recipe: CustomRecipe }
  | { ok: false; fieldErrors: { customRecipe: string } } {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return {
      ok: false,
      fieldErrors: { customRecipe: "Enter valid JSON for the custom recipe." },
    };
  }
  const parsed = customRecipeSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join(" ");
    return {
      ok: false,
      fieldErrors: { customRecipe: details || "The custom recipe is invalid." },
    };
  }
  return { ok: true, recipe: parsed.data };
}

export function persistIntentDraft(
  storage: BrowserStorage,
  input: unknown,
): boolean {
  const parsed = intentDraftSchema.safeParse(input);
  if (!parsed.success) return false;
  try {
    storage.setItem(INTENT_DRAFT_STORAGE_KEY, JSON.stringify(parsed.data));
    return true;
  } catch {
    return false;
  }
}

export function loadIntentDraft(
  storage: BrowserStorage,
): { draft?: IntentDraft; storageAvailable: boolean } {
  try {
    const raw = storage.getItem(INTENT_DRAFT_STORAGE_KEY);
    if (!raw) return { storageAvailable: true };
    const parsed = intentDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      storage.removeItem(INTENT_DRAFT_STORAGE_KEY);
      return { storageAvailable: true };
    }
    return { draft: parsed.data, storageAvailable: true };
  } catch {
    return { storageAvailable: false };
  }
}

export function clearIntentDraft(storage: BrowserStorage): boolean {
  try {
    storage.removeItem(INTENT_DRAFT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
