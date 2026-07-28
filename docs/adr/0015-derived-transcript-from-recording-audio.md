# ADR 0015: Derive a transcript from the recording's own audio

- Status: Accepted
- Date: 2026-07-28
- Amends: ADR 0012 clause 5 (video-only prompts previously carried no transcript)

## Invariant

Every transcript that reaches a prompt or a manifest must state where it came
from. Context derived from the operator-selected recording itself is
first-party evidence support, not fabricated meeting context — but it must be
labeled as derived, never presented as provider or operator input.

## Context

Videos that do not come from Bluedot or Granola — downloaded videos, screen
captures, local meeting exports — previously ran transcript-less. That loses
Pass-2 aligned transcript slices, prompt vocabulary, and future pre-clip
ability, even though the recording's own audio track contains the words.

ADR 0012 forbids fabricating meeting provenance for video-only runs, and its
clause 5 assumed video-only prompts carry no transcript at all. A transcript
derived from the recording's audio does not fabricate anything: it is a
lossy restatement of evidence already inside the trust boundary, produced by
the same provider (Gemini) that already receives the pixels and audio.

## Decision

1. Resolve transcripts through an explicit ladder: provider transcript, then
   operator context file, then a derived transcript, then none. The derived
   rung runs only when the effective transcript is empty and the operator has
   not passed `--no-derived-transcript`.
2. Derive by stripping the first audio stream locally with ffmpeg (metadata
   stripped, mono ADTS AAC) and running a Gemini audio-only structured
   transcription pass on the same model as the run. Speaker labels are generic
   (`Speaker N`) and never guessed names; name attribution remains a video-pass
   evidence job.
3. The stage is nonfatal and never a gate: missing ffmpeg, no audio track, or
   a failed transcription emits a warning and the run continues transcript-less
   exactly as before.
4. The derived transcript is untrusted context. It enters prompts only inside
   the escaped `<transcript>` delimiter with its derived origin stated, feeds
   Pass-2 nearby slices at offset 0 (same recording, so alignment is exact by
   construction), and is never persisted to the run bundle.
5. Both manifest versions record optional provenance
   `derivedTranscript: { origin: "gemini-audio", model, sha256 }`. A v2 run
   whose transcript was derived hashes the derived text into
   `transcriptSha256` and pins `transcriptAlignment` to explicit offset 0.
   Video-only runs remain schema v3; a derived transcript never fabricates a
   meeting, provider, transport, or meeting identity.
6. The remote audio upload is deleted immediately after transcription in
   success and failure paths, and the local audio derivative is removed with
   the run's temporary directory.
7. Amend ADR 0012 clause 5: video-only prompts may carry a transcript **only**
   when it is derived from the selected recording's own audio and labeled as
   such. All other clauses of ADR 0012 stand.

## Consequences

- Provider-less recordings gain aligned transcript slices and prompt
  vocabulary for roughly one tenth of the video pass cost (audio bills at
  ~32 tokens/second versus ~300 tokens/second for video at default
  resolution).
- ADR 0009's transcript-minimization disclosure extends to the derived rung:
  the full derived transcript is transferred to Gemini within the analysis
  session that produced it, and only its digest is retained.
- Strict manifest validators gained an optional field without a schema bump;
  in-repo consumers were updated in lockstep per `docs/VERSIONING.md`.
- Per-role model provenance (ADR 0014 prerequisite) is satisfied for this
  role by recording the transcription model in the provenance object; a
  transcription model different from the run model remains future work.
