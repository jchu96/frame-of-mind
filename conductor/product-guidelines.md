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

### Recording First

The recording is the primary interaction object. Provider context, transcript,
recipe, and focus enrich it; they do not obscure which media is being analyzed.

### Progressive Disclosure

The default path should require four understandable decisions: recording,
context, intent, and run. Alignment, model, sampling, retention, and transport
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
| Context | Bluedot, Granola, or local meeting/transcript information |
| Intent | A built-in or custom analysis recipe plus optional focus |
| Run | One immutable analysis attempt and its portable output bundle |
| Job | The durable execution state that produces a run |
| Candidate | A time range selected during whole-video indexing |
| Finding | An accepted or rejected interrogation result |
| Staging | Temporary private storage used before and during execution |
| Projection | Rebuildable SQLite or D1 data derived from durable run contracts |
