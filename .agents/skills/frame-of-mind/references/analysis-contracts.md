# Analysis Contracts

Load this reference when changing or interpreting generated run files.

## `analysis.json`

Authoritative recipe output:

```text
schemaVersion
recipe
  id
  label
meeting? (schema v2)
  id
  provider
  title?
  createdAt?
  sourceUrl?
context? (schema v3)
  mode: none
model
matchNotes
items[]
  candidate
    start
    end
    speaker?
    surface?
    summary
    kind
    importance
  result
    accepted
    kind
    title
    summary
    details[]?
    where?
    evidence?
    steps[]?
    importance?
    confidenceNotes?
  screenshot?
```

Accepted and rejected records both remain for audit.

## `manifest.json`

Run provenance:

- tool/schema/prompt versions;
- run times and meeting ID;
- recipe ID/label/custom flag;
- model;
- input hashes and media type;
- context/media source classes;
- transcript alignment;
- Gemini remote deletion status;
- analysis bounds/resolution;
- artifact inventory.

It must not contain credentials, signed URLs, raw provider payloads, full
transcripts, remote file URI, or local input path.

## `analysis-outcome.json`

Strict auxiliary status receipt:

- indexed, selected, limit-omitted, validated, accepted, rejected, and failed
  candidate counts;
- complete, partial, or failed detail outcome;
- candidate ordinal/time window;
- sanitized error code, bounded attempts, and schema path/code pairs.

It never contains rejected values or provider/model payloads.

## `failure-manifest.json`

Whole-run failure receipt published after upload begins and before a normal
bundle becomes authoritative. It records phase, sanitized error
classification, hashes, and `not_obtained`, `confirmed_deleted`,
`intentionally_retained`, or `unconfirmed` cleanup. It is not importable as an
analysis run.

## `analysis.md`

Human-readable, GitHub-friendly renderer. It includes accepted records only and
references screenshots by safe relative basename.

## `report.html`

Self-contained local review renderer. It embeds screenshots and must escape all
provider/model content. It is sensitive even though it is portable.

## `moment-*.png`

Optional timestamped frames for accepted records. They are derived meeting data
and inherit the recording's sensitivity.

## Contract rules

- JSON is authoritative; renderers never invent data.
- Schema versions change independently of CLI version.
- Screenshot names are relative and validated.
- Unsupported future schema versions fail closed.
- Publishing is a separate, explicitly authorized action.
