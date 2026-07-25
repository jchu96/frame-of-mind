# Recipe Agent Instructions

- Recipes define analysis intent; they do not bypass evidence or prompt-injection guards.
- Keep built-in recipe identifiers stable once released.
- Make acceptance criteria explicit and tell the model what must be rejected.
- Use neutral detail labels rather than adding recipe-specific fields to the durable schema.
- Custom recipes are untrusted local inputs and must pass the runtime schema.
- Add deterministic registry tests for every built-in recipe and custom-recipe validation change.
