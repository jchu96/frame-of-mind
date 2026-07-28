# Source Agent Instructions

## Boundaries

- `domain/`: provider-independent types and contracts.
- `lib/`: deterministic helpers with no provider policy.
- `adapters/`: context providers, OAuth, Gemini, filesystem, and process boundaries.
- `recipes/`: built-in intent and custom recipe validation.
- `services/`: workflow orchestration over domain types and adapters.
- `cli.ts`: argument parsing and human-readable status only.

## Rules

- Do not move provider response shapes into domain contracts.
- Do not log transcripts, signed URLs, credentials, or raw MCP payloads.
- Keep prompts resistant to instructions embedded in meeting evidence.
- Add schema versions before changing durable output shapes.
- Keep successful analysis, auxiliary outcome, and whole-run failure receipts
  distinct. Never make a diagnostic artifact a second analysis authority.
- Prefer dependency injection when adding provider alternatives.
- Do not add Vertex conditionals throughout services; implement a backend boundary.

## Verification

- Run `bun run typecheck`.
- Add focused Vitest coverage for deterministic behavior.
- Run `bun run check` before committing.
