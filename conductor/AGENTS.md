# Conductor Agent Instructions

## Sources of Truth

- Read `product.md`, `tech-stack.md`, and `workflow.md` before changing a track.
- `tracks.md` is the registry; each active track owns `spec.md`, `plan.md`,
  `review.md`, `index.md`, and `metadata.json`.
- Architecture and trust-boundary decisions remain canonical in `docs/adr/`.

## Synchronization

- Keep plan checkboxes, metadata phase/task counts and pointers, index progress,
  and the registry status consistent in the same commit.
- Do not mark a task or phase complete before its verification gate passes.
- Record task commits with the track ID; keep one task per commit when practical.
- Pause at phase boundaries as required by `workflow.md`.
- Update the specification and plan together when accepted scope changes.
- Add or amend an ADR when a change alters authority, retention, or trust.
- Archive only completed or explicitly abandoned tracks, preserving the reason.

## File-Scoped Commands

| Task | Command |
|------|---------|
| Find pending work | `rg -n '^- \[ \]' conductor/tracks/<track>/plan.md` |
| Check formatting | `git diff --check -- conductor/` |
| Run a phase gate | `bun run check` |

## Commit Attribution

AI commits MUST include:

```text
Co-Authored-By: (the agent's name and attribution byline)
```
