# Decision: default analysis model → `gemini-4-hydrogen`

- Date: 2026-11-12 (docs fetched 2026-11-12, ~22:00Z, from `ai.google.dev` `.md.txt` sources)
- Scope: `DEFAULT_GEMINI_MODEL`, `.env.example`, the tests that pin the default, and the docs that state it
- Status: recommended and implemented on `feat/gemini-4-hydrogen`; the credentialed `bun run smoke:gemini` is still owed at harvest

## Verified facts (Google's own pages)

| Fact | Value | Source |
| --- | --- | --- |
| Exact model id | `gemini-4-hydrogen` (stable; the only version listed) | [Model page](https://ai.google.dev/gemini-api/docs/models/gemini-4-hydrogen), [Models index](https://ai.google.dev/gemini-api/docs/models), [Release notes 2026-11-12](https://ai.google.dev/gemini-api/docs/changelog#11-12-2026), [Pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-4-hydrogen), [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations) |
| Release state | GA, 2026-11-12; no shutdown date announced | [Release notes](https://ai.google.dev/gemini-api/docs/changelog#11-12-2026), [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations) |
| Inputs | Text, Image, **Video**, Audio, PDF → Text | [Model page](https://ai.google.dev/gemini-api/docs/models/gemini-4-hydrogen) |
| Video through the Files API | Documented: `files.upload` → `generateContent` with `file_data { file_uri, mime_type }` on `models/gemini-4-hydrogen:generateContent`; `videoMetadata.fps` and clipping are documented on the same page | [Video understanding (generateContent view)](https://ai.google.dev/gemini-api/docs/video-understanding?generate-content=true#upload-video) |
| Available on `generateContent` | Yes, on both GenerateContent and the Interactions API | [What's new in Gemini 4 Hydrogen](https://ai.google.dev/gemini-api/docs/whats-new-gemini-4-hydrogen) |
| Context limit | 1,048,576 tokens **unified** (input + thinking + output); max output 65,536 synchronous (up to 1,048,576 with long decode) | [Model page](https://ai.google.dev/gemini-api/docs/models/gemini-4-hydrogen) |
| Structured output | Supported; `responseJsonSchema` example uses `gemini-4-hydrogen` | [Structured outputs (generateContent view)](https://ai.google.dev/gemini-api/docs/structured-output?generate-content=true) |
| Media resolution | Global `mediaResolution` still documented for generateContent; Gemini 4/3 video is 70 tokens/frame at `low` and `medium` (the same for both), 280 at `high` | [Media resolution (generateContent view)](https://ai.google.dev/gemini-api/docs/media-resolution?generate-content=true#global-media-resolution) |
| Thinking | `low`, `medium`, `high` (**default**), `xhigh`; `minimal` is rejected | [Thinking](https://ai.google.dev/gemini-api/docs/thinking#thinking-levels) |
| Paid price | $1.50 / 1M input, $7.50 / 1M output (thinking included), $0.075 implicit-cache input; free tier available | [Pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-4-hydrogen) |
| Files API retention and size | 48 h auto-delete; 2 GB per file (the video page lists 20 GB paid / 2 GB free) | [Files API](https://ai.google.dev/gemini-api/docs/files), [Video understanding](https://ai.google.dev/gemini-api/docs/video-understanding#upload-video) |

The id is the same on every page checked: the model page, models index, release notes, pricing, deprecations, the what's-new page, and the video, thinking, structured-output and media-resolution pages. The news-reported id was correct.

## The current default (`gemini-3.7-flash`)

- **Deprecated.** Google no longer serves it as itself: "API requests to `gemini-3.7-flash` are automatically routed to `gemini-3.8-flash`" ([3.7 Flash model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash)).
- **Retirement date:** none. The deprecations table lists the shutdown date as "N/A", and says "the endpoint is not shutting down and automatically routes API requests to `gemini-3.8-flash`" ([Deprecations](https://ai.google.dev/gemini-api/docs/deprecations)).
- So today's default is in practice **3.8 Flash under a 3.7 label**. The manifest's recorded model id no longer names the model that ran. That is already a reproducibility defect, apart from this upgrade.

## Price against the current default

The effective current model is `gemini-3.8-flash` ([pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash)):

| | Input / 1M | Output / 1M |
| --- | --- | --- |
| `gemini-3.8-flash` (what 3.7 routes to) to 2026-12-31 | $0.75 | $3.75 |
| `gemini-3.8-flash` from 2027-01-01 | $1.50 | $7.50 |
| `gemini-4-hydrogen` | $1.50 | $7.50 |

Hydrogen costs twice as much per token until year-end, and the same from 2027-01-01. It also defaults to `high` thinking where 3.8 Flash defaults to `medium`, and thinking tokens bill as output. Expect more output tokens per call at this repo's unchanged request shape.

## Request-parameter changes that touch this repo

Checked against the migration checklist in [What's new](https://ai.google.dev/gemini-api/docs/whats-new-gemini-4-hydrogen#migrate-from-gemini-3-8-flash) and the generateContent config in `src/adapters/gemini.ts` (index, detail and transcribe calls):

| Migration item | This repo | Change needed? |
| --- | --- | --- |
| `thinking_level` default becomes `high`; `minimal` errors | No `thinkingConfig` is sent | No. The default rises to `high` (cost and latency, not shape) |
| Explicit caching unsupported | No `cachedContents` or `caches.*` | No |
| `temperature` / `top_p` / `top_k` ignored | Not sent | No |
| Low hardcoded `maxOutputTokens` | Not sent; the 65,536 default equals 3.7's output limit | No |
| Declare structured output natively | `responseMimeType` plus `responseJsonSchema` already | No |
| Thought signatures in multi-turn histories | Single-turn calls; the corrective regeneration is a fresh request | No |
| `mediaResolution` global LOW / MEDIUM | Still documented; video tokens per frame match Gemini 3 | No |
| `fileData` plus `videoMetadata.fps` | Documented for Hydrogen on generateContent | No |
| Agentic video processing | Opt-in only; static (1 FPS) stays the default | No (not adopted) |

**Schemas, retries, upload and cleanup are not changed.** None of the verified docs require a change. `@google/genai` 2.21.0 (the pin at the base SHA) passes the model string through and the repo sends no new enum values, so no SDK bump is required for this change.

## Recommendation

Adopt `gemini-4-hydrogen` as the pinned default now. Google names it the "recommended upgrade from Gemini 3.8 Flash and earlier Gemini 3 and 2.5 models". It is GA with no shutdown date, and it accepts video through the Files API on the stable `generateContent` path this repo uses, with no request-shape change. The pinned 3.7 id is already a silent alias, so the move also restores an honest manifest model id.

Conditions:

1. The hub's credentialed `bun run smoke:gemini` at harvest is the live proof (upload, index, detail, delete). These docs are evidence that it should pass, not proof that it does.
2. Watch latency against `MODEL_REQUEST_TIMEOUT_MS` (10 min) on long recordings. `high` thinking is the new default. If the detail phase regresses, setting `thinkingConfig.thinkingLevel: "medium"` (3.8 Flash's default) is a request-shape change and needs its own decision. It is not made here.
3. Cost roughly doubles per token until 2026-12-31. The friend's private copy can pin `GEMINI_MODEL=gemini-3.8-flash` until year-end if cost matters more than quality.

## Worth a follow-up: Decisions API for a closed-question clip grader

Released 2026-11-11 ([Decisions API](https://ai.google.dev/gemini-api/docs/decisions-api), `gemini-decision-1`, `v1beta`). It returns calibrated binary, categorical or rubric `score` answers with probabilities and zero output tokens, and accepts video.
That shape fits a cheap accept/reject or rubric pass over interrogated clips: "is this candidate inside the recipe?", or b-roll usability grading.
It is Beta (`v1beta`) and would be a new provider seam beside `generateContent`, so it needs an ADR-level look at retention and schema boundaries.
Not evaluated here (non-goal). Suggested as an eval-harness experiment, not a production change.
