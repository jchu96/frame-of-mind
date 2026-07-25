# ADR 0003: Separate meeting context, media, and renderers

Status: accepted

## Invariant

An evidence run must remain reproducible and inspectable when a meeting provider, AI client, or presentation surface changes.

## Decision

The pipeline has three independent inputs and outputs:

1. a context adapter returns normalized meeting metadata, summary, and transcript;
2. a media input supplies the screen recording to inspect;
3. renderers transform the versioned analysis into Markdown, HTML, or future platform-specific exports.

Bluedot MCP, Granola MCP, and local context files share the same context interface. The current media path is local video, with a narrowly validated Bluedot signed-URL fallback. `analysis.json` and `manifest.json` are the durable record. `report.html` is a self-contained rendering, not a second source of truth.

The normal run does not retain raw provider payloads or the full transcript. It persists hashes, provenance, selected issue evidence, and derived screenshots.

## Consequences

- A Granola note can be paired with a separately captured screen recording.
- A Bluedot recording download policy can change without changing Gemini analysis.
- Claude can display or transform the HTML/Markdown output without owning the only copy.
- Clip-to-transcript alignment becomes an explicit pipeline stage and manifest field.
- New adapters must normalize provider payloads before they reach analysis.
- New renderers must consume the analysis contract and must not invent facts.

## Rejected

- Storing the only result in Claude Artifacts: platform-specific, hard to version, and weak for automated downstream use.
- Persisting raw MCP responses by default: unnecessary privacy and retention risk.
- Treating provider notes as a substitute for video: insufficient for visible UI evidence.
