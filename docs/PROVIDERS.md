# Meeting Context Providers

Frame of Mind separates meeting context from screen-recording media. A context
provider supplies normalized metadata, summary, and transcript. It is not
assumed to supply downloadable video.

## Provider matrix

| Provider | Transport | Authentication | Transcript | Video |
|---|---|---|---|---|
| Bluedot | MCP | browser OAuth | yes | may be absent from MCP |
| Granola | MCP | browser OAuth | plan/policy dependent | no independent assumption |
| Granola | REST API | bearer API key | eligible notes/scopes | no |
| Local file | filesystem | local access | supplied file | separate local video |

## Bluedot MCP

Endpoint:

```text
https://app.bluedothq.com/api/v1/mcp
```

Authorize:

```bash
frameofmind auth bluedot
```

Analyze:

```bash
frameofmind analyze "<video-id>" \
  --source bluedot \
  --video "<recording.mp4>" \
  --recipe requirements
```

### Identifier

The adapter discovers the `get_meeting` input schema and prefers:

```text
videoId
video_id
meetingId
meeting_id
recordingId
recording_id
id
```

The live contract used `videoId`.

### Output normalization

The adapter extracts:

- meeting/recording ID;
- title;
- created/recorded/start time;
- summary;
- timestamped speaker transcript;
- Bluedot preview URL.

### Duration schema gotcha

Observed July 25, 2026:

- the tool advertised an output schema;
- the server returned an ISO-8601 duration;
- the SDK's high-level `callTool` validation rejected that value;
- the underlying MCP envelope was otherwise usable.

The adapter calls `tools/call` through `client.request` and validates
`CallToolResultSchema`, avoiding the inconsistent tool-level output schema.

Do not remove this workaround without a live and fixture-based contract test.

### Recording availability

Observed `get_meeting` returned summary/transcript but no stable recording URL.
The supported normal workflow is:

1. open the authorized meeting in Bluedot;
2. download only the intended recording;
3. pass its local path with `--video`.

If a response later contains media, discovery remains an adapter seam.

### Signed URL

`--recording-url` is accepted only for Bluedot and only when:

- scheme is HTTPS;
- hostname exactly matches the verified Bluedot media host;
- redirects remain valid;
- response is media;
- size/time limits are satisfied.

The URL is never stored in the manifest.

## Granola MCP

Endpoint:

```text
https://mcp.granola.ai/mcp
```

Authorize:

```bash
frameofmind auth granola
```

Analyze:

```bash
frameofmind analyze "<meeting-id>" \
  --source granola \
  --granola-transport mcp \
  --video "<recording.mp4>" \
  --recipe decisions
```

### Official tools

Granola documents:

- `query_granola_meetings`
- `list_meeting_folders`
- `list_meetings`
- `get_meetings`
- `get_meeting_transcript`

Frame of Mind uses `get_meetings` and `get_meeting_transcript`.

### Access gotchas

- MCP uses the active Granola workspace.
- Browser OAuth is per user.
- Basic-plan data can be time-limited.
- Transcript/folder tools can require a paid plan.
- Enterprise administrators can control scopes.
- A meeting may be unavailable until processing/summary completes.

### Argument discovery

The adapter discovers the tool input schema and supports singular/plural
meeting/note identifier keys. Plural keys receive an array.

### Timestamp normalization

Granola API-shaped transcript chunks can use absolute ISO timestamps. Frame of
Mind normalizes them relative to the first chunk so the analyzer can align
video-relative and transcript-relative time.

## Granola REST API

Base:

```text
https://public-api.granola.ai/v1
```

The API is an explicit transport. It never silently replaces MCP.

Configure:

```bash
export GRANOLA_API_KEY="your-key"
```

Analyze:

```bash
frameofmind analyze "not_XXXXXXXXXXXXXX" \
  --source granola \
  --granola-transport api \
  --video "<recording.mp4>" \
  --recipe action-items
```

### Note endpoint

```text
GET /v1/notes/{note_id}?include=transcript
```

The documented note ID matches:

```text
not_ + 14 alphanumeric characters
```

### Key scope

Granola documents personal/public/workspace scopes depending on plan, role, and
workspace policy. Use a key with only the required scope. Do not share one
colleague's key.

### API behavior

- notes without completed summary/transcript may be excluded or return 404;
- rate limits can return 429;
- 401/403 indicates key/scope/policy failure;
- response size is capped locally;
- redirects are rejected;
- the key is sent only in the Authorization header;
- the raw response is not persisted in a normal run.

### MCP versus API

Choose MCP when:

- a colleague is running interactively;
- browser OAuth is acceptable;
- the active workspace and user scopes are desired.

Choose API when:

- an eligible key already exists;
- the note ID is known;
- automation needs non-interactive access;
- key scope and rotation are governed.

Never auto-fallback because it changes identity and accessible data.

## Local file

Use when:

- provider access is unavailable;
- transcript tools are plan-restricted;
- an export was already authorized;
- deterministic fixtures are required.

```bash
frameofmind analyze "stable-local-id" \
  --source file \
  --context-file "<context.json>" \
  --video "<recording.mp4>" \
  --recipe repo-plan
```

For JSON, recognizable fields include title/name, created/date/start, summary,
and transcript/transcription/segments. Plain text/Markdown/SRT/VTT content is
treated as transcript context.

Protect the file and delete it under the source retention policy after use.

## Adding a provider

1. Implement `MeetingContextSource`.
2. Keep authentication local to the adapter.
3. Normalize timestamps and speaker labels.
4. Preserve provider/transport in the manifest.
5. Add strict runtime validation.
6. Add offline fixtures with invented content.
7. Document plan/scope/retention.
8. Return actionable fallbacks.
9. Never couple the provider to recipes/renderers.
10. Do not assume context storage is media storage.

## Official documentation

- [Bluedot MCP](https://help.bluedothq.com/en/articles/14708332-bluedot-mcp)
- [Granola MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp)
- [Granola API](https://docs.granola.ai/introduction)
- [Granola Get Note](https://docs.granola.ai/api-reference/get-note)
