# Meeting-to-Issue Workflow

Load this reference when the user wants a meeting analyzed into a GitHub issue,
implementation plan, reporting specification, or repository change proposal.

## Contents

- Invariant
- Workflow
- Attribution
- Reporting and BI lens
- GitHub issue structure
- Failure checks

## Invariant

Process the least media needed to understand the requested problem, while
retaining every relevant clarification and labeling direct evidence separately
from inference.

## Workflow

1. Confirm the intended provider identity, meeting access, Gemini transfer,
   target repository, and publication authority.
2. Fetch transcript context before uploading video.
3. Normalize provider timestamps and preserve raw speaker tags. Bluedot's
   `speakerTag` owns the text that follows it.
4. Define semantic scope from the topic, not only a named person's airtime.
5. Select one or more complete conversational windows, including collaborator
   corrections and clarifications.
6. Cut private local derivatives outside the repository; preserve the original.
7. Record each full-meeting clip-start timestamp as its transcript offset.
8. Analyze each offset-compatible clip with the recipe matching the requested
   artifact.
9. Review manifest, analysis, screenshots, rejected candidates, attribution,
   offsets, and remote cleanup.
10. Inspect the target repository's agent guidance, architecture, current data
    model, implementation seams, tests, and related issues.
11. Build an evidence ledger with:
    - direct request;
    - collaborative clarification;
    - analyst inference;
    - confidence and timestamp.
12. Draft the issue with explicit user outcome, current/target state, data and
    metric contracts, exact repository seams, phases, acceptance criteria,
    tests, observability, non-goals, and open decisions.
13. Run a cold-reader and adversarial review.
14. Create or edit the issue only when explicitly authorized.
15. Verify rendered Markdown, diagrams, links, and image access.
16. Delete temporary clips and drafts; preserve the user-supplied original.

The current CLI has no fetch-only command. Use the authorized provider UI,
provider MCP tool, or an existing local export to scope timestamps. Each clip's
index pass still sends the full normalized transcript; use bounded local context
when transcript minimization is required.

## Attribution

Never silently “fix” a provider transcript. Preserve the raw tag, then use:

1. audio;
2. visible active-speaker or participant labels;
3. continuous adjacent turns;
4. direct address and grammar as supporting signals.

If the evidence remains ambiguous, say so.

## Reporting and BI lens

Before prescribing UI, define:

- the user decision;
- grain and dimensions;
- numerator and denominator;
- start/end events;
- timezone and calendar;
- missing, canceled, reopened, and duplicate behavior;
- reproducibility from stored facts;
- operational versus managerial views.

Useful extrapolation is allowed. Label it as BI interpretation or
implementation recommendation instead of presenting it as a direct quote.

## GitHub issue structure

Include:

1. problem and intended decision;
2. source scope and evidence classes;
3. current behavior;
4. target experience and user flow;
5. requirements;
6. metric contracts;
7. conceptual data model;
8. exact repository seams;
9. phased delivery;
10. acceptance criteria and tests;
11. rollout and observability;
12. non-goals and open decisions;
13. privacy and provenance notes.

Prefer normal GitHub attachments. Do not expose meeting content in a public
branch. A dedicated non-default issue-assets branch in a private target is a
last resort that requires explicit authorization, nonzero-size validation, and
a clear instruction that it must not merge.

## Failure checks

- Whole meeting analyzed for a narrow request: reselect transcript windows.
- Named speaker isolated too narrowly: include the full relevant turn.
- Wrong transcript window: calculate and pass the clip offset.
- Speaker looks wrong: preserve raw attribution and apply the evidence ladder.
- Gemini schema rejected: use the supported provider subset and strict local
  Zod validation; never cast or weaken the durable schema.
- Screenshot upload failed: use a documented/manual attachment path, not
  extracted browser credentials or undocumented upload APIs.
- Issue is generic: inspect current code/data/test seams before publication.
- Metrics conflict: define one canonical contract and surface the decision.

For the complete operator procedure in a clone, read
`docs/MEETING_TO_ISSUE_RUNBOOK.md` and ADR 0009.
