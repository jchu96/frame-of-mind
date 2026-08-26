# Contribution conventions status

- Branch: `chore/contribution-conventions`
- Adapted daimon's contribution guide, pull request template, and issue forms
  for Frame of Mind's Bun, CLI, web, workflows, hosted Studio, and CI surfaces.
- Added evidence-led issue-writing guidance grounded in Frame of Mind issue
  #120, plus richer bug and feature forms.
- Added a repository-owned Conventional Commit hook and matching CI hygiene
  enforcement, including focused fixtures for invalid subjects.
- Recorded source provenance at `pymc-labs/daimon@bd31039`.
- Opened draft pull request [#121](https://github.com/jchu96/frame-of-mind/pull/121):
  `chore: adopt contribution conventions (CONTRIBUTING, templates, commit hooks)`.
- Required CI-shaped `check:pr` lanes pass. The full local sharded upgrade also
  found and reproduced an unrelated hosted-auth copy assertion on unchanged
  `origin/main`; the draft records that base failure without weakening the gate.

DONE fomcontrib
