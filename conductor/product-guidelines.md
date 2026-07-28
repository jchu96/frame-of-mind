# Product Guidelines

## Voice And Tone

- Calm, precise, and trustworthy
- Plain language before implementation terminology
- Honest about uncertainty, cost, retention, and cleanup
- Progress-oriented without pretending that a stage has completed
- Helpful errors that state what happened, what remains safe, and what to do

Avoid surveillance language, inflated claims, and generic AI phrasing. Prefer
"Examine candidate moments" over "Unlock insights."

## Design Principles

### Recording Anchored, Entry Flexible

The recording is the required evidence object, but the user may begin with the
question, optional context, or recording. Provider context, transcript, recipe,
and focus enrich the recording; they do not obscure which media is analyzed or
pretend that missing context exists.

### Progressive Disclosure

The default path should require a recording and intent, offer context as an
explicit enrichment, and end with a run receipt. These sections may be
completed in any order. Alignment, model, sampling, retention, and transport
details belong in advanced controls.

### Visible Trust Boundaries

Before bytes move, show where they will be staged, which provider receives
them, and when temporary copies will be deleted. Never hide cloud transfer
behind a generic spinner.

### Durable Progress

Every analysis is a persisted job with a stable identifier and stage history.
Navigation, refresh, or browser closure must not invent a second run or lose
the state of the first.

### Evidence Is Navigable

Selecting a finding seeks the video to the relevant timestamp and shows the
aligned transcript excerpt. Evidence, inference, and recommendation remain
visually distinguishable.

### Draft Before Publish

Exports may prepare Markdown or tracker payloads, but external publication
always requires a separate, explicit user action.

### Local Means Local

Local mode binds to loopback, stores private state outside the checkout, and
does not depend on a cloud control plane. Gemini remains an explicit remote
processor until a local model backend exists.

## Terminology

| Term | Meaning |
|---|---|
| Studio | The Nuxt user interface for creating, monitoring, and reviewing runs |
| Recording | The selected local video input |
| Context | Optional Bluedot, Granola, or local meeting/transcript information |
| Intent | A built-in or custom analysis recipe plus optional focus |
| Run | One immutable analysis attempt and its portable output bundle |
| Job | The durable execution state that produces a run |
| Candidate | A time range selected during whole-video indexing |
| Finding | An accepted or rejected interrogation result |
| Staging | Temporary private storage used before and during execution |
| Projection | Rebuildable SQLite or D1 data derived from durable run contracts |
