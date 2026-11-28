# 0033. A second analysis engine on one recording

Proposed · 2026-11-28 · Local CLI analysis · Extends ADRs 0024 and 0032

## Context

One caller can use different engines to find and examine moments in a recording. Sending media to a second company changes who receives it and who can delete it. The local recording remains authoritative for measured edges.

## Decision

Each engine resolves its own key. Plan the route before making a provider request and name every recipient, its material and its retention policy. With both keys, Twelve Labs proposes on the selected video and operator definition. Gemini grades the selection using candidate windows, scoped context and labelled stills. A caller may reverse the order, use one engine, or supply a candidates file. Only the grader receives a proposal claim, in one escaped evidence sentence, unless the caller withholds it.

A default proposal failure before a valid document can move both roles to the already disclosed Gemini route. A valid empty result ends proposal. A partial result preserves validated rows and reports incomplete coverage. Explicit role selection fixes the route. Both providers use the candidates validator and grading pipeline. Edge measurements stay local.

Many real recordings exceed the 200 MB direct-upload limit. A shorter local time range can fit. Oversize selections return `media-limit` before transmission. The default dual route falls back and a chosen route returns retry arguments. Direct upload keeps all media requests on the disclosed Twelve Labs API origin.

Record scratch-creation intent durably before issuing each request. Store the returned IDs, sent digest and selection in an account-scoped receipt. Keep an uncertain creation unconfirmed. Delete only owned tasks and assets, verify identity and absence, and retain pending receipts on any link or doubt. Entity checks and deletion are separate requests, so concurrent users must keep these scratch assets exclusive. Gemini upload retention remains an independent operator setting. [Engine contract](../ENGINE_CONTRACT.md)

## Consequences

The caller can preview routing offline and inspect what was sent, retained or deleted after a successful, partial or failed run. Interrupted remote creation can leave an unidentified copy. Later runs can reconcile known IDs without replaying an uncertain charge. Named libraries, search and whole-shoot analysis are outside this decision.
