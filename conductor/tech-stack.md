# Tech Stack

## Languages

- TypeScript 5.9 in strict mode
- Vue single-file components
- SQL for SQLite and D1 migrations
- Markdown and Mermaid for public architecture and operations documentation

## Frontend

- Nuxt 4 and Vue 3
- Nuxt UI 4 with Tailwind CSS 4
- Route-level hybrid rendering:
  - public/documentation routes may be prerendered or SSR;
  - authenticated Studio routes are client-rendered application surfaces.
- Shared Zod contracts for forms, API payloads, jobs, and durable run imports

## Backend

### Phase A

- Nuxt Nitro server running through Bun on loopback
- Per-launch local Studio session capability
- Concurrency-one analysis queue in the Bun application process
- Existing provider adapters and Gemini analysis services
- Private OS application-data directories for configuration, staging, and runs

### Phase B

- Nuxt Nitro Cloudflare Worker
- Cloudflare Access with in-application JWT verification
- Durable hosted job orchestration behind the same `AnalysisJobExecutor`
  contract
- Direct browser-to-R2 multipart media transfer; Workers authorize and
  coordinate but do not proxy recording bytes

## Data And Infrastructure

- `analysis.json` plus `manifest.json` are the durable completed-run authority
- Bun SQLite is operational authority for active jobs and stores rebuildable
  completed-run projections
- Phase B may use D1 as operational hosted job state plus rebuildable completed
  run projections
- Local filesystem staging stores Phase A recording bytes temporarily
- Private Cloudflare R2 is the proposed Phase B staging adapter
- GitHub Actions runs public continuous integration

## Key Dependencies

- Bun 1.3.14 or newer for install, workspaces, scripts, tests, and local runtime
- `@google/genai` for Gemini Files and structured video analysis
- `@modelcontextprotocol/sdk` for Bluedot and Granola MCP
- Zod for all untrusted boundaries
- Nuxt UI for accessible dashboard, form, modal, navigation, and progress
  primitives
- `jose` for hosted Cloudflare Access validation

## Architectural Interfaces

The Studio track should introduce stable interfaces before UI coupling:

```ts
interface MediaStagingAdapter {
  create(input: MediaDescriptor): Promise<StagedMedia>;
  writePart(input: MediaPart): Promise<MediaPartReceipt>;
  complete(input: CompleteMediaUpload): Promise<StagedMedia>;
  abort(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

interface AnalysisJobExecutor {
  enqueue(input: CreateAnalysisJob): Promise<AnalysisJob>;
  cancel(jobId: string): Promise<AnalysisJob>;
  retry(jobId: string): Promise<AnalysisJob>;
  status(jobId: string): Promise<AnalysisJob>;
}

interface MeetingCatalogSource {
  list(input: MeetingCatalogQuery): Promise<MeetingCatalogPage>;
}
```

`MeetingCatalogSource` is optional; providers without it retain exact meeting-ID
entry. Phase A implements staging and execution with Bun and local files. Phase
B may implement them with R2 and hosted orchestration without changing browser
contracts.

Local-only implementations must be excluded from the Cloudflare artifact.
Hosted review routes cannot import `bun:sqlite`, secret-session storage, local
staging, the executor, or the media byte-range server.
