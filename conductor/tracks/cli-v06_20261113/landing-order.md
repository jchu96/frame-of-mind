# Landing order: work in flight on 2026-11-23

Read at `main` `519f402` (PR #160, merged 2026-11-22). One delivery lead now
runs this repository and the new `exact-time` library. This page lists the
work in the order it will land, what each item waits for, and the decisions
that belong to the owner. It is replaced, not appended to, when the order
changes.

## Rules for the order

- No file has two owners at once. `package.json` and `bun.lock` are the
  contended files below: the dependency updates, the `exact-time` adoption
  and the release bundle all touch them, so they land one after another.
- Every merge needs the owner's word, one independent review at the exact
  head, and green required checks at that head.
- Every new public branch, new repository and release needs the owner's word.

## Order

| # | Item | Waits for | Owner decision |
|---|------|-----------|----------------|
| 1 | This track brought up to date: waves 0 and 1 merged, the exact-time groundwork merged, flaky gate steps and follow-ups recorded (branch `docs/cli-v06-track`, 4 commits plus this page, documents only) | nothing | merge, once a pull request is open |
| 2 | Development dependency group update (PR #143): mergeable, required checks green | one review at its head | merge |
| 3 | Silent `frameofmind` command, and the upload clean-up wording made the same in the skill and in the command help; retention behaviour unchanged (`fix/cli-silent-and-upload-docs`) | builder reports done; one review | push the branch, open the pull request, merge |
| 4 | A teaching-points recipe (`feat/teaching-points-recipe`) | builder reports done; one review; lands after item 3 if both touch the recipe registry | push the branch, open the pull request, merge |
| 5 | Dependency updates PR #136 (vue), #137 (zod), #138 (`@better-auth/core`), #139 (`jose`): each conflicts with `main` and its `Check` job failed | a rebase onto `main`, then green checks; zod and `@better-auth/core` touch durable validation and sign-in, so each gets its own review | rebase request, then merge each |
| 6 | `exact-time` 0.1.0: the frame-exact time library extracted from `src/domain/exact-time.ts`, with Python parity | its build lane finishes and is reviewed independently | create the public repository (MIT), push, tag the first release with file fingerprints |
| 7 | This repository takes `exact-time` as a dependency pinned to that tag; the in-repository copy and its contract table are replaced, and the existing time tests and the portable case table must pass unchanged against the dependency | item 6 released; items 2 and 5 landed (lockfile) | merge |
| 8 | Release bundle: when a version is tagged, CI attaches the built command-line tool and its SHA-256 to the GitHub release, so a consumer downloads and verifies one file instead of rebuilding from source (today about 1 GB of source and dependencies per checkout) | item 7, so the bundle carries the pinned library; a choice of bundle shape (below) | bundle shape; the first release that carries it |
| 9 | Clean-up of what the tool leaves on a Mac and in the cloud: one lane per flaw that is the tool's own | an independent read of what is left behind, in progress; known so far, about 115 MB of cached builds under `~/.cache/frame-of-mind` and about 1 GB per checkout | which flaws to fix |
| 10 | Waves 2 to 4 of this track (word-accurate times and ffmpeg helpers; ask again without uploading again; local MCP server) | items 7 and 8; wave 2 specifications rewritten on the exact-time module | none until each wave's specification is ready |

Not scheduled: the cut-rhythm measure (spec, "Candidate, not scheduled"),
and the hosted transcript size limit, which falls harder on non-Latin
scripts and can split a character in two.

## Decisions for the owner

1. **Pull requests and comments.** May the delivery lead open pull requests
   and post the rebase request on dependency updates itself? Default: yes,
   with each merge still on the owner's word.
2. **`exact-time` repository.** Create the public repository under the
   owner's account, MIT licence, once its review is clean. Default: yes, at
   0.1.0.
3. **Bundle shape for item 8.** A single-file bundle with its runtime
   dependencies inside (one download, nothing to install), or the package
   tarball (smaller, but needs its runtime dependencies installed). Default:
   the single-file bundle, checked by running `frameofmind --version` and
   `doctor` from the downloaded file in CI before it is attached.
4. **First release with the bundle.** v0.6.0 when all its waves land, or
   an earlier release cut from `main` so consumers stop rebuilding now
   (`main` already holds new commands and flags, so its number is the
   owner's call). Default: an earlier release straight after item 8.
5. **Dependency updates in conflict.** Rebase #136 to #139, or close them
   and let the next weekly run open fresh ones. Default: rebase.
