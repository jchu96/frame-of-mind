# ADR 0024: Upload retention is an operator setting

- Status: Accepted
- Date: 2026-11-13
- Supersedes: the CLI recording-upload delete-by-default rule in root and service agent instructions and video-understanding documentation. Studio policy and ADR 0015 derivative cleanup remain unchanged.

## Invariant

A recording upload lives for the policy the operator chose. Its retention and
provider expiry must be visible; the tool never deletes an operator-owned
local recording.

## Context

Repeated recipe runs can reuse the same verified upload. Deleting the recording
copy after each run prevents that workflow. Hosted Studio is a separate trust
boundary, and its explicit cleanup contract is outside this CLI change.

## Decision

CLI `analyze` resolves explicit flags, then `FRAME_OF_MIND_UPLOAD_RETENTION`,
then `provider`. `provider` keeps the recording upload until provider expiry;
`run` deletes it on terminal paths. `--keep-upload` and `--delete-upload` are
aliases. Invalid or conflicting settings fail before upload. Reused uploads
are never deleted by a run that did not create them.

The CLI reports provider expiration, or "expiration not reported", and the
2 GB per-file limit. The manifest records deletion state and available expiry.
This Part A continues showing the remote name; private session registration
and opaque IDs belong to Part B.

Temporary local downloads and derivatives are still removed. Derived-audio
uploads and failed upload-processing cleanup retain their existing guarantees;
this setting governs the recording upload returned to analysis. Studio callers
continue passing their explicit policy rather than inheriting CLI environment.

Future stored answers must remain local until the operator deletes the exact
directory: mode 0600 files beneath a 0700 root, protected by OS disk encryption.
Part A creates no answer archive or session store.

## Consequences

A default CLI run leaves a remote recording copy for longer. Visibility and
explicit `run` mode make that tradeoff inspectable. Provider expiry remains the
upper bound; an unknown expiration is reported rather than invented.

## Alternatives considered

Keeping delete-by-default would require an opt-in on every iterative run.
Changing hosted defaults would cross another trust boundary and is deferred.

## Reference

[Gemini Files API](https://aistudio.google.com/docs/files.md) documents file
metadata, deletion and provider expiry.
