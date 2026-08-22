import { describe, expect, test } from "bun:test";
import { DEFAULT_GEMINI_MODEL } from "../../../src/adapters/gemini";
import {
  INTENT_DRAFT_STORAGE_KEY,
  loadIntentDraft,
  parseCustomRecipeImport,
  persistIntentDraft,
  validateIntentDraft,
} from "../server-local/studio-ui/intent-composer";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("Studio Intent composer", () => {
  test("persists exactly the immutable composer intent fields", () => {
    const storage = new MemoryStorage();
    const draft = {
      recipe: { id: "requirements" },
      focus: "Prioritize explicit acceptance criteria.",
      model: DEFAULT_GEMINI_MODEL,
    };

    expect(persistIntentDraft(storage, draft)).toBe(true);
    expect(loadIntentDraft(storage)).toEqual({
      draft,
      storageAvailable: true,
    });
    expect(JSON.parse(storage.values.get(INTENT_DRAFT_STORAGE_KEY)!)).toEqual(
      draft,
    );
  });

  test("reports focus overflow without saving it", () => {
    const storage = new MemoryStorage();
    const invalid = {
      recipe: { id: "requirements" },
      focus: "x".repeat(10_001),
      model: DEFAULT_GEMINI_MODEL,
    };

    expect(validateIntentDraft(invalid)).toMatchObject({
      ok: false,
      fieldErrors: { focus: expect.any(String) },
    });
    expect(persistIntentDraft(storage, invalid)).toBe(false);
    expect(storage.values.has(INTENT_DRAFT_STORAGE_KEY)).toBe(false);
  });

  test("strictly validates a custom recipe before any persistence", () => {
    const valid = {
      id: "synthetic-review",
      label: "Synthetic review",
      description: "Review an invented fixture.",
      indexInstruction: "Find relevant synthetic moments.",
      interrogationInstruction: "Verify each synthetic moment.",
    };
    expect(parseCustomRecipeImport(JSON.stringify(valid))).toEqual({
      ok: true,
      recipe: valid,
    });

    const invalid = parseCustomRecipeImport(JSON.stringify({
      ...valid,
      charter: { stance: "Unknown keys must fail." },
    }));
    expect(invalid).toMatchObject({
      ok: false,
      fieldErrors: { customRecipe: expect.any(String) },
    });

    const storage = new MemoryStorage();
    expect(persistIntentDraft(storage, {
      recipe: { custom: { ...valid, extra: "must fail" } },
      model: DEFAULT_GEMINI_MODEL,
    })).toBe(false);
    expect(storage.values.has(INTENT_DRAFT_STORAGE_KEY)).toBe(false);
  });
});
