# Analysis Contracts

Load this reference when changing or interpreting generated run files.

## `analysis.json`

Authoritative recipe output:

```text
schemaVersion
recipe
  id
  label
meeting
  id
  provider
  title?
  createdAt?
  sourceUrl?
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
