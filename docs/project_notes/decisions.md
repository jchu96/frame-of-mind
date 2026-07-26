# Decisions

## 2026-07-25 — Providers supply context, media is a separate input

Bluedot, Granola, and local files implement one meeting-context contract. The screen recording is passed independently. This preserves the core invariant when a provider has transcripts but no downloadable video.

## 2026-07-25 — Claude Artifacts are a renderer, not storage

The durable source of truth is a portable local run bundle. `report.html` provides an artifact-like, self-contained review surface that can be opened locally or attached to another workflow. Platform-specific Claude output may be added as an exporter, but no analysis depends on Claude-hosted artifact state.

## 2026-07-25 — Keep generated data outside the checkout

Default runs use the operating system's per-user application-data directory. This prevents accidental commits, keeps public clones clean, and makes retention an explicit operator concern.

## 2026-07-25 — Persist excerpts and hashes, not raw provider context

Normal analyses retain recipe-relevant excerpts plus recording/transcript hashes. They do not persist raw MCP payloads or complete transcripts. A future opt-in archive must have an explicit retention and encryption design.

## 2026-07-25 — Frame of Mind is a multi-purpose video-understanding product

Issue evidence is one recipe, not the product boundary. The public brand is Frame of Mind, repository slug `frame-of-mind`, CLI `frameofmind`, and skill `frame-of-mind`. Positioning: “Video in. Understanding out.”

## 2026-07-25 — Granola MCP and REST API are explicit peer transports

Browser OAuth is the default colleague-run path. The official REST API is an explicit `--granola-transport api` path for eligible keys and automation. The tool never silently falls back between identities.

## 2026-07-25 — The review database is a projection

The portable run bundle remains authoritative. A Nuxt SSR workspace may import
reviewed `analysis.json` and `manifest.json` into local SQLite or Cloudflare D1.
Hosted imports are explicit and protected by Cloudflare Access plus in-app JWT
validation.

## 2026-07-26 — Run bundles are cryptographically paired

Schema v2 places the run ID in both contracts and the canonical
`analysis.json` SHA-256 in `manifest.json`. Import and hydration revalidate the
pair; normalized database columns are only a projection and must match it.
Schema v1 imports fail closed and must be regenerated.

## 2026-07-26 — MCP OAuth credentials are exact-resource scoped

Canonical provider endpoints retain stable token paths for usability. Every
custom HTTPS endpoint gets an origin-hashed token path, and stored credentials
include the exact MCP resource URL. No provider token may cross that boundary.

## 2026-07-25 — MCP follows the read-only retrieval pattern

The first Frame of Mind MCP surface is deferred to the next iteration. Local
stdio and Cloudflare Streamable HTTP will share read-only run query contracts;
analysis, media, provider authentication, deletion, and publishing stay outside
the initial tool set.
