# Introducing Frame of Mind

**Video in. Understanding out.**

We now have a local tool for turning meeting recordings into structured work.
Frame of Mind combines the actual screen recording with context from Bluedot,
Granola, or a local transcript, then runs the analysis recipe you choose.

Use it for:

- decisions and rationale;
- requirements and acceptance criteria;
- action items and ownership;
- repository change plans;
- grounded product/UX issue reviews.

Unlike a normal meeting summary, Frame of Mind can inspect what was visible on
screen and align it with what was said. Every run produces local JSON with
provenance, a reviewable Markdown file, a self-contained HTML report, and
optional screenshots.

## Get started

```bash
gh repo clone jchu96/frame-of-mind
cd frame-of-mind
bun install --frozen-lockfile
bun run check
bun run build
bun link
```

Create a Gemini auth key in Google AI Studio, export it locally, then:

```bash
frameofmind doctor
frameofmind recipes
```

Authorize Bluedot or Granola:

```bash
frameofmind auth bluedot
frameofmind auth granola
```

Example:

```bash
frameofmind analyze "MEETING_ID" \
  --source bluedot \
  --video "./recording.mp4" \
  --recipe requirements \
  --max-moments 3
```

## Use it with Codex or Claude

```bash
bun run install:skill -- --target all
```

Restart your agent and ask it to use the Frame of Mind skill.

## Important

- Use only meetings and recordings you are authorized to process.
- Do not paste API keys, provider tokens, signed URLs, or transcripts into chat.
- Gemini temporarily receives the selected video; Frame of Mind deletes the
  upload by default.
- Review every generated record before publishing it.
- The tool does not automatically create Asana tasks, GitHub issues, or messages.

Full setup and troubleshooting are in the
[README](../README.md) and [runbook](RUNBOOK.md).
