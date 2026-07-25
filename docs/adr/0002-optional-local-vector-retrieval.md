# ADR 0002: Make vector retrieval optional and local

Status: Proposed

## Invariant

Embeddings may accelerate discovery, but they must never become the evidence
source of truth or recreate the centralized Aftercall archive.

## Decision

The initial release has no embedding dependency. Stable analysis schemas and
deterministic artifact references come first.

If colleagues demonstrate a cross-meeting retrieval need, add a separate,
explicit local layer:

- `frameofmind index add <run-root>`
- `frameofmind search "<query>"`
- `frameofmind index status|rebuild|prune`

Index accepted records and analysis sections by default; make transcript-window indexing
opt-in. Store content plus vectors in a replaceable SQLite cache under the OS
application-data directory. Combine SQLite FTS5 with in-process cosine scoring
and reciprocal-rank fusion. Search results must point back to artifact paths,
meeting IDs, exact timestamps, and excerpts.

Use an `EmbeddingProvider` boundary. The first remote implementation may use the
current Google Gen AI embedding model at 768 dimensions, but model choice must
be revalidated when this proposed ADR is implemented.

## Rejected for now

- Shared vector service
- Background synchronization
- A daemon or hosted API
- Embedding raw video or screenshots
- Making search/index state necessary to analyze one meeting
