# ADR 0009: Use transcript-first semantic scoping for bounded media analysis

- Status: Accepted
- Date: 2026-07-27

## Invariant

Frame of Mind must process the least media needed to answer the operator's
question without discarding context that materially changes the answer.

## Context

A provider transcript can cover an entire meeting while the operator asks about
one topic, one workflow, or one person's request. Uploading the whole available
recording increases privacy exposure, cost, latency, and irrelevant model
attention.

The opposite shortcut is also unsafe: limiting the evidence to a named
speaker's airtime can omit collaborators who clarify, correct, or complete the
requirement. Speaker diarization itself can be wrong, and Bluedot's
`speakerTag` labels the transcript text that follows it.

The current CLI analyzes the complete operator-selected `--video`. It does not
automatically cut a source recording into semantic windows.

## Decision

For topic- or speaker-scoped work:

1. Fetch and normalize authorized context before any Gemini upload.
2. Use timestamped transcript evidence to identify one or more semantic
   windows.
3. Include the complete relevant conversational turn, regardless of speaker,
   with small setup and resolution padding.
4. Create private local derivative clips outside the repository and pass those
   clips as the operator-selected videos.
5. Record the signed full-transcript-to-clip offset for each derivative.
6. Analyze distinct windows independently when their offsets differ.
7. Preserve the provider's raw speaker attribution and make any derived
   correction evidence-backed and explicit.
8. During synthesis, distinguish direct requests, collaborative clarification,
   and analyst inference.
9. Fall back to an operator-selected whole video only when timestamped scoping
   is impossible or the operator explicitly requests whole-recording discovery.

Automatic semantic clipping may be added later behind an explicit preview and
operator confirmation. This ADR does not claim that automation ships today.

The current index pass still sends the full normalized meeting transcript for
each selected clip. This decision therefore minimizes video transfer by
default, not transcript transfer. When transcript minimization is required, the
operator must use an authorized bounded local context file until the product
ships a context-preview and transcript-window contract.

## Consequences

- Less private media is transferred to Gemini.
- The full normalized transcript remains a separate disclosed transfer unless
  the operator supplies bounded local context.
- Analysis is faster and less distracted by unrelated content.
- Multiple clips can produce multiple run bundles and offsets that must be
  reconciled during synthesis.
- A named person is a search signal, not the final evidence boundary.
- Untimestamped transcripts require explicit operator bounds or whole-selected
  media analysis.
- The original recording remains untouched; derivative cleanup is a separate
  operator responsibility.
- Issue authors must label inference instead of suppressing useful product or
  BI extrapolation.

## Alternatives Considered

### Always upload the whole recording

Rejected because available media is not equivalent to authorized semantic
scope. It creates unnecessary privacy, cost, and relevance risk.

### Cut only the named speaker's turns

Rejected because requirements are often co-constructed and diarization can be
wrong.

### Analyze only the transcript

Rejected for screen-recording workflows because visible state and timing are
first-class evidence.

### Have the model choose scope after upload

Rejected as the default because the privacy and cost decision would occur only
after the complete media had already crossed the remote boundary.
