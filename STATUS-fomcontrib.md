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
- Required CI-shaped `check:pr` lanes pass. A full local sharded run reproduced
  an unrelated hosted-auth copy assertion on unchanged `origin/main`; GitHub's
  hosted lane separately hit the pre-existing D1 `SQLITE_BUSY_SNAPSHOT` flake
  in Better Auth workflow testing (also seen on main run `32927066193`). Neither
  failure is attributed to this documentation and repository-tooling diff.

DONE fomcontrib
