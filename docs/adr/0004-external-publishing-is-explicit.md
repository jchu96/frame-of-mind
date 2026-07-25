# ADR 0004: Keep external publishing explicit

Status: accepted

## Invariant

Analysis authorization does not imply permission to create or modify work in
Asana, GitHub, Linear, Notion, Slack, or Claude-hosted surfaces.

## Decision

External systems are exporter boundaries over a reviewed `analysis.json`.
Exporters must:

1. require an explicit exporter command;
2. default to preview/dry-run;
3. require a second explicit apply/publish flag for writes;
4. select exact accepted record IDs;
5. show the destination project/repository before mutation;
6. avoid sending rejected records or full meeting context;
7. never infer credentials or destination from meeting content;
8. record a sanitized publication receipt separately from the analysis;
9. remain idempotent where the destination supports it;
10. redact tokens and provider payloads from errors.

An Asana PAT, GitHub token, or other credential present in the environment is
not authorization to use it.

Claude Artifacts remain a renderer/export target. They are not the sole durable
copy.

## Consequences

- `v0.1.0` performs no external publishing.
- A future Asana exporter should have preview and apply phases.
- A future GitHub exporter should draft body content before issue creation.
- Agents must ask or rely on an explicit user command before external writes.
- Local analysis remains usable without any task-management credential.
