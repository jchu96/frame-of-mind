# Product

## Summary

Frame of Mind is a local-first video-understanding workbench. It combines an
authorized recording with meeting context and a structured analysis recipe,
then produces portable, reviewable outputs grounded in exact video moments.

Positioning: **Video in. Understanding out.**

## Problem Statement

Transcripts omit visible application state, cursor movement, hesitation,
before-and-after transitions, and examples that participants point at instead
of naming. Existing meeting tools summarize conversation but do not reliably
turn screen recordings into inspectable product, engineering, operational, or
research artifacts.

The v0.2 CLI performs the analysis and the Nuxt workspace reviews completed
bundles. The missing product surface is a cohesive Studio that lets a user
configure authorized providers, select or drop a recording, choose the desired
kind of understanding, observe a durable job, and review timestamp-linked
results without composing command-line arguments.

## Target Users

- Engineers converting demos and review calls into grounded implementation work
- Product and design teams extracting decisions, requirements, and UX friction
- Operators converting recorded workflows into actions and process improvements
- Researchers reviewing screen-based interviews
- Individual contributors who need private, local processing before sharing

The first Studio release targets one user on one machine. Team-hosted execution
is a later deployment mode.

## Goals

1. Make the complete local analysis workflow usable without the CLI.
2. Keep recordings, credentials, and generated runs private by default.
3. Make every long-running stage observable, recoverable, and explainable.
4. Preserve the portable versioned run bundle as the durable authority.
5. Provide a high-quality evidence review surface linked to the recording.
6. Keep local and future cloud execution behind explicit adapter contracts.
7. Keep the public repository safe to clone, inspect, and contribute to.

## Constraints

- A run must remain inspectable when its provider, model, recipe, renderer, or
  execution environment changes.
- A browser tab is not the durable job boundary.
- The normal local workflow must not require Cloudflare, R2, D1, or hosted auth.
- New API secrets must never be returned to the browser or persisted in
  plaintext Studio storage.
- Recording bytes must not enter Git, SQLite, D1, logs, or analytics.
- Generated analyses remain sensitive even when the source repository is public.
- The first release requires a supported video recording and Gemini Developer
  API access.
- Hosted execution must not proxy large recording bodies through a Worker.

## Product Phases

### Phase A - Local Studio

Nuxt UI in the browser, an authenticated loopback Bun process, local filesystem
staging, operational SQLite job state, rebuildable run projections,
environment- or session-scoped API secrets, and the existing Gemini analysis
pipeline.

### Phase B - Hosted Studio

Cloudflare Access, D1 metadata, private R2 multipart staging, durable hosted job
orchestration, explicit retention, and server-managed secrets. Phase B must
reuse Phase A's job, media, analysis, and run contracts rather than fork the
product.

### Later Extensions

- Read-only local and hosted MCP access to completed runs
- Draft exports to GitHub, Asana, and other trackers
- Context-only recipes
- Alternative model/media backends
- Optional derived search or embeddings over completed analyses
