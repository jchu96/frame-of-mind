# Recipe Agent Instructions

- Recipes define analysis intent; they do not bypass evidence or prompt-injection guards.
- Keep built-in recipe identifiers stable once released.
- Make acceptance criteria explicit and tell the model what must be rejected.
- Use neutral detail labels rather than adding recipe-specific fields to the durable schema.
- Intent is a valid interpretation target when it is labeled, grounded in
  observed behavior, and paired with alternatives; never present hidden intent
  as an observed fact.
- Keep current depth behavior honest: it changes sampling/prompt rigor under the
  v2/v3 schema. Typed artifact families and role-separated synthesis require a
  future schema version under ADR 0014.
- Custom recipes are untrusted local inputs and must pass the runtime schema.
- Add deterministic registry tests for every built-in recipe and custom-recipe validation change.
