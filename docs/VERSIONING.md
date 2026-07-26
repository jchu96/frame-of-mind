# Versioning and Releases

Frame of Mind uses Semantic Versioning for the CLI/package and explicit
versions for durable schemas and prompts.

## Version surfaces

| Surface | Current | Change rule |
|---|---:|---|
| CLI/package | `0.2.0` | Semantic Versioning |
| `analysis.json` schema | `2` | increment for breaking shape/meaning |
| `manifest.json` schema | `2` | increment for breaking provenance changes |
| prompt revision | `2026-07-26.1` | increment for material instruction changes |
| built-in recipe ID | stable string | do not rename after release |

## Before 1.0

- patch: fixes, documentation, tests, compatible provider normalization;
- minor: new recipe/provider/renderer/command or compatible contract field;
- major: reserved for the stable 1.0 contract; before then, breaking CLI changes
  require a minor bump and prominent migration notes.

## Release checklist

1. Update package version.
2. Update `CHANGELOG.md`.
3. Confirm README and runbook commands.
4. Confirm official provider and Google links.
5. Run `bun install --frozen-lockfile`.
6. Run `bun run check`.
7. Validate the repository skill.
8. Test the skill installer in a temporary home directory.
9. Run `bun audit --production --audit-level=high`.
10. Review generated package contents.
11. Confirm no secrets, recordings, transcripts, or runs are tracked.
12. Commit with the release version.
13. Create an annotated `vX.Y.Z` tag.
14. Push commit and tag.
15. Create a GitHub release from the changelog.

## Model and dependency updates

Model changes require:

- official availability verification;
- prompt/structured-output test;
- video upload and cleanup test;
- changelog note;
- manifest model record.

`@google/genai` updates require:

- compare installed and registry versions;
- read official release/migration notes;
- verify `files.upload/get/delete`;
- verify media metadata and response JSON schema;
- run the full check suite.

Provider SDK updates require OAuth, tool discovery, schema, and cleanup tests.

## Schema compatibility

Renderers must reject unsupported future major schema versions instead of
guessing. Compatible optional fields may be added without incrementing schema
version only when old consumers safely ignore them.

Schema 2 is intentionally incompatible with schema 1 imports. It adds a shared
run ID, an analysis digest in the manifest, strict canonical timestamps, and
recipe revision/content provenance. Re-run the original source analysis to
migrate; do not hand-edit a v1 bundle into v2 because its evidence was not
validated under the v2 timestamp and pairing rules.

## Prompt revision

Use a date plus sequence:

```text
2026-07-25.2
```

Increment when changing:

- inclusion/rejection policy;
- transcript alignment instruction;
- evidence/inference rules;
- structured output semantics;
- built-in recipe behavior.

Formatting-only code changes do not require a prompt revision.
