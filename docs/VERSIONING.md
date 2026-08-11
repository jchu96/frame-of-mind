# Versioning and Releases

Frame of Mind uses Semantic Versioning for the CLI/package and explicit
versions for durable schemas and prompts.

## Version surfaces

| Surface | Current | Change rule |
|---|---:|---|
| CLI/package | `0.3.0` | Semantic Versioning |
| `analysis.json` schema | `2` | increment for breaking shape/meaning |
| `manifest.json` schema | `2` | increment for breaking provenance changes |
| prompt revision | `2026-08-11.1` | increment for material instruction changes |
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
7. Run `bun run smoke:gemini` with a maintainer key and generated media.
8. Validate the repository skill.
9. Test the skill installer in a temporary home directory.
10. Run `bun audit --production --audit-level=high`.
11. Review generated package contents.
12. Confirm no secrets, recordings, transcripts, or runs are tracked.
13. Commit with the release version.
14. Create an annotated `vX.Y.Z` tag.
15. Push commit and tag.
16. Create a GitHub release from the changelog.

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
- verify documented resumable upload plus SDK `files.get/delete`;
- verify media metadata and response JSON schema;
- run `bun run smoke:gemini`;
- run the full check suite.

Provider SDK updates require OAuth, tool discovery, schema, and cleanup tests.

## Schema compatibility

Renderers must reject unsupported future major schema versions instead of
guessing. Compatible optional fields may be added without incrementing schema
version only when old consumers safely ignore them.

Optional `derivedTranscript` manifest provenance was added to schema 2 and
schema 3 under that additive-field rule, without a schema bump: it appears only
when a run transcribed the recording's own audio, and a consumer that ignores it
still reads a correct run. The rule carries a condition that this release had to
satisfy explicitly. Because both manifest validators are strict, an unknown key
is a hard rejection, so the additive field only stays compatible when every
validator that will read it is updated in lockstep in the same release. That is
what shipped here; do not backport a bundle carrying the field to a release
whose validators predate it. Two additional caveats: on schema 2 the addition
also changes what two pre-existing fields refer to — `transcriptSha256` may now
digest derived text rather than provider text, and `transcriptAlignment` is
pinned to explicit offset 0 — so a v2 consumer must check `derivedTranscript`
before attributing the transcript to the context provider (a cross-field schema
refinement now enforces the pinned relationship). And because SQLite/D1 run
reads re-validate stored manifests, rolling a deployed projection back to a
pre-`derivedTranscript` release makes previously stored derived runs unreadable
at detail-view time; roll the reader forward, not the bundles back.

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
